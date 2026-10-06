-- Usage analytics views, read by HyperDX's usage timeline and dashboards as the
-- hyperdx user (hyperdx.xml). Run by the ClickHouse admin through
-- analytics-init.sh, after Langfuse and the HyperDX collector have created their
-- tables.
--
-- Each view runs with its definer's rights, so the hyperdx user needs no access
-- to the tables behind it. The views deliberately leave out conversation
-- content: Langfuse's input, output, metadata and tool_calls, score comments
-- and string values, and every span attribute other than the ones listed.
--
-- Safe to re-run: the views are dropped and created again. Not CREATE OR
-- REPLACE: replacing swaps the definitions with renameat2(), which the EFS
-- (NFS) volume ClickHouse runs on in AWS does not support. Dropping goes in
-- reverse order of use, timeline first, as it reads the other views.

CREATE DATABASE IF NOT EXISTS analytics;

DROP VIEW IF EXISTS analytics.timeline;
DROP VIEW IF EXISTS analytics.feedback;
DROP VIEW IF EXISTS analytics.llm_generations;
DROP VIEW IF EXISTS analytics.llm_traces;
DROP VIEW IF EXISTS analytics.ui_events;

-- Named UI actions (client/src/lib/rum/actions.ts) and page views, from the
-- browser telemetry the HyperDX collector stores.
CREATE VIEW analytics.ui_events
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    Timestamp AS time,
    SpanName AS action,
    SpanAttributes['userId'] AS user_id,
    SpanAttributes['role'] AS user_role,
    if(SpanName = 'spa-route-change', SpanAttributes['toPath'], SpanAttributes['route']) AS route,
    if(SpanName = 'spa-route-change', SpanAttributes['fromPath'], '') AS from_route,
    SpanAttributes['conversationId'] AS conversation_id,
    SpanAttributes['endpoint'] AS endpoint,
    SpanAttributes['model'] AS model,
    SpanAttributes['agentId'] AS agent_id,
    SpanAttributes['rating'] AS rating,
    SpanAttributes['count'] AS file_count,
    ServiceName AS service
FROM hyperdx.otel_traces
WHERE SpanName LIKE 'message.%'
   OR SpanName IN ('model.switch', 'agent.switch', 'file.upload', 'conversation.new', 'spa-route-change');

-- Langfuse 4 stores the app's OpenTelemetry traces in events_core, one row per
-- span (agent, chain, tool, model call), each carrying its trace's user,
-- session (the LibreChat conversation) and trace name. Its older traces and
-- observations tables stay empty for this ingestion path.

-- One row per response the app traced in Langfuse.
CREATE VIEW analytics.llm_traces
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    trace_id,
    min(start_time) AS time,
    any(trace_name) AS name,
    any(user_id) AS user_id,
    any(session_id) AS session_id,
    any(environment) AS environment,
    any(tags) AS tags
FROM default.events_core FINAL
WHERE is_deleted = 0
GROUP BY trace_id;

-- Model calls within those traces: model, timing, token usage and cost.
CREATE VIEW analytics.llm_generations
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    span_id AS generation_id,
    trace_id,
    trace_name,
    user_id,
    session_id,
    environment,
    start_time,
    end_time,
    dateDiff('millisecond', start_time, end_time) AS duration_ms,
    name,
    provided_model_name AS model,
    usage_details,
    total_cost,
    level,
    tool_call_names
FROM default.events_core FINAL
WHERE is_deleted = 0 AND type = 'GENERATION';

-- Feedback and other scores on traces (thumbs up/down arrive here).
CREATE VIEW analytics.feedback
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    id AS score_id,
    trace_id,
    timestamp AS time,
    name,
    value,
    data_type,
    source
FROM default.scores FINAL
WHERE is_deleted = 0;

-- Every event above on one timeline, one row per event, in the column layout
-- HyperDX expects of a log source (Timestamp, ServiceName, SeverityText, Body,
-- LogAttributes). HyperDX's "Usage timeline" source and dashboards read it
-- (otel/hyperdx/provision). ServiceName says where the event came from: `ui`
-- (browser), `llm` (a model call) or `feedback` (a score). Scores take their
-- user and conversation from their trace.
CREATE VIEW analytics.timeline
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    toDateTime64(time, 3) AS Timestamp,
    'ui' AS ServiceName,
    'info' AS SeverityText,
    if(action = 'spa-route-change', 'page.view', toString(action)) AS Event,
    if(action = 'spa-route-change', concat('page.view ', route), toString(action)) AS Body,
    user_id AS UserId,
    conversation_id AS ConversationId,
    model AS Model,
    toUInt64(0) AS InputTokens,
    toUInt64(0) AS OutputTokens,
    toUInt64(0) AS TotalTokens,
    toFloat64(0) AS Cost,
    toInt64(0) AS DurationMs,
    rating AS Rating,
    '' AS TraceId,
    mapFilter((k, v) -> v != '', map(
        'user_role', user_role, 'route', route, 'from_route', from_route,
        'endpoint', endpoint, 'agent_id', agent_id, 'file_count', file_count
    )) AS LogAttributes
FROM analytics.ui_events
UNION ALL
SELECT
    toDateTime64(g.start_time, 3),
    'llm',
    multiIf(g.level = 'ERROR', 'error', g.level = 'WARNING', 'warn', g.level = 'DEBUG', 'debug', 'info'),
    'llm.generation',
    concat('llm.generation ', g.model),
    g.user_id,
    g.session_id,
    g.model,
    -- Langfuse's `input` counts only uncached prompt tokens; prompt caching
    -- puts most of LibreChat's system prompt under the cache keys.
    g.usage_details['input'] + g.usage_details['input_cache_read'] + g.usage_details['input_cache_creation'],
    g.usage_details['output'],
    g.usage_details['total'],
    toFloat64(g.total_cost),
    ifNull(g.duration_ms, 0),
    '',
    g.trace_id,
    mapFilter((k, v) -> v != '', map(
        'generation_id', g.generation_id, 'generation_name', g.name, 'trace_name', g.trace_name,
        'tools', arrayStringConcat(g.tool_call_names, ','), 'environment', toString(g.environment)
    ))
FROM analytics.llm_generations AS g
UNION ALL
SELECT
    f.time,
    'feedback',
    if(f.name = 'user-feedback' AND f.value = 0, 'warn', 'info'),
    multiIf(f.name != 'user-feedback', concat('score.', f.name), f.value = 1, 'feedback.thumbs_up', 'feedback.thumbs_down'),
    multiIf(f.name != 'user-feedback', concat('score.', f.name, ' ', toString(f.value)), f.value = 1, 'feedback.thumbs_up', 'feedback.thumbs_down'),
    ifNull(t.user_id, ''),
    ifNull(t.session_id, ''),
    '',
    toUInt64(0),
    toUInt64(0),
    toUInt64(0),
    toFloat64(0),
    toInt64(0),
    multiIf(f.name != 'user-feedback', toString(f.value), f.value = 1, 'thumbsUp', 'thumbsDown'),
    ifNull(f.trace_id, ''),
    mapFilter((k, v) -> v != '', map('score_id', f.score_id, 'score_name', f.name, 'score_source', f.source))
FROM analytics.feedback AS f
LEFT JOIN analytics.llm_traces AS t ON t.trace_id = f.trace_id;
