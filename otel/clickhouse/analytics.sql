-- Usage analytics views, read by HyperDX's usage timeline and dashboards as the
-- hyperdx user (hyperdx.xml). Run by the ClickHouse admin through
-- analytics-init.sh, after Langfuse and the HyperDX collector have created their
-- tables.
--
-- Each view runs with its definer's rights, so the hyperdx user needs no access
-- to the tables behind it.
--
-- The views carry conversation content: each turn's message and reply, every
-- model call's full input (the prompt, history included) and output, and
-- feedback with its reason, free-text comment and metadata. Anyone who can sign
-- in to HyperDX can read them. Only span attributes other than the ones listed
-- stay out.
--
-- Safe to re-run: the views are dropped and created again. Not CREATE OR
-- REPLACE: replacing swaps the definitions with renameat2(), which the EFS
-- (NFS) volume ClickHouse runs on in AWS does not support. Dropping goes in
-- reverse order of use, timeline first, as it reads the other views.

CREATE DATABASE IF NOT EXISTS analytics;

DROP VIEW IF EXISTS analytics.timeline;
DROP VIEW IF EXISTS analytics.chat_turns;
DROP VIEW IF EXISTS analytics.feedback;
DROP VIEW IF EXISTS analytics.llm_generations;
DROP VIEW IF EXISTS analytics.spans;
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

-- Langfuse 4 stores the app's OpenTelemetry traces in events_full, one row per
-- span (agent, chain, tool, model call), each carrying its trace's user,
-- session (the LibreChat conversation) and trace name; events_core is the same
-- with input, output and metadata cut to 200 characters. Its older traces and
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

-- Every span of those traces, whatever its type (agent, chain, tool, retriever,
-- model call, event), with its full input and output, in the column layout
-- HyperDX expects of a trace source, so its trace viewer shows each turn as a
-- tree: HyperDX's "Conversation traces" source reads it. SpanAttributes holds
-- everything else Langfuse records about the span: model settings, every usage
-- and cost figure, tool calls and the tools offered, tags, release, version and
-- its metadata (prefixed usage., cost., tool_definition. and metadata.).
CREATE VIEW analytics.spans
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    toDateTime64(start_time, 9) AS Timestamp,
    trace_id AS TraceId,
    span_id AS SpanId,
    parent_span_id AS ParentSpanId,
    name AS SpanName,
    toString(type) AS SpanKind,
    multiIf(parent_span_id = '', 'chat', type = 'GENERATION', 'llm', lower(toString(type))) AS ServiceName,
    -- Nanoseconds; a span still running counts as zero.
    toUInt64(greatest(0, dateDiff('microsecond', start_time, ifNull(end_time, start_time)))) * 1000 AS Duration,
    if(level = 'ERROR', 'Error', 'Unset') AS StatusCode,
    status_message AS StatusMessage,
    toString(level) AS Level,
    user_id AS UserId,
    session_id AS ConversationId,
    trace_name AS TraceName,
    toString(environment) AS Environment,
    provided_model_name AS Model,
    if(completion_start_time IS NULL, toInt64(0), dateDiff('millisecond', start_time, completion_start_time)) AS TimeToFirstTokenMs,
    usage_details AS Usage,
    total_cost AS Cost,
    tool_call_names AS ToolCallNames,
    input AS Input,
    output AS Output,
    mapFilter((k, v) -> v != '', mapConcat(
        map(
            'model_parameters', model_parameters, 'release', release, 'version', version,
            'tags', arrayStringConcat(tags, ','), 'tool_call_names', arrayStringConcat(tool_call_names, ','),
            'tool_calls', arrayStringConcat(tool_calls, '\n'), 'prompt_name', prompt_name,
            'prompt_version', ifNull(toString(prompt_version), ''), 'trace_name', trace_name,
            'environment', toString(environment), 'status_message', status_message
        ),
        mapApply((k, v) -> (concat('usage.', k), toString(v)), CAST(usage_details, 'Map(String, UInt64)')),
        mapApply((k, v) -> (concat('cost.', k), toString(v)), CAST(cost_details, 'Map(String, Decimal(18, 12))')),
        mapApply((k, v) -> (concat('tool_definition.', k), v), tool_definitions),
        mapFromArrays(arrayMap(n -> concat('metadata.', n), metadata_names), metadata_values)
    )) AS SpanAttributes,
    mapFilter((k, v) -> v != '', map(
        'service.name', service_name, 'service.version', service_version,
        'telemetry.sdk.name', telemetry_sdk_name, 'telemetry.sdk.version', telemetry_sdk_version
    )) AS ResourceAttributes
FROM default.events_full FINAL
WHERE is_deleted = 0;

-- One row per conversation turn: the trace's root span, whose input is what the
-- user sent and whose output is the reply, as Langfuse stores them (JSON for
-- structured values).
CREATE VIEW analytics.chat_turns
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    TraceId AS trace_id,
    Timestamp AS time,
    TraceName AS name,
    UserId AS user_id,
    ConversationId AS session_id,
    intDiv(Duration, 1000000) AS duration_ms,
    Level AS level,
    StatusMessage AS status_message,
    Input AS input,
    Output AS output,
    SpanAttributes AS attributes
FROM analytics.spans
WHERE ParentSpanId = '';

-- Model calls within those traces: model, timing, time to first token, token
-- usage, cost, and the full input and output.
CREATE VIEW analytics.llm_generations
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    SpanId AS generation_id,
    TraceId AS trace_id,
    TraceName AS trace_name,
    UserId AS user_id,
    ConversationId AS session_id,
    Timestamp AS start_time,
    intDiv(Duration, 1000000) AS duration_ms,
    TimeToFirstTokenMs AS time_to_first_token_ms,
    SpanName AS name,
    Model AS model,
    Usage AS usage_details,
    Cost AS total_cost,
    Level AS level,
    StatusMessage AS status_message,
    ToolCallNames AS tool_call_names,
    Input AS input,
    Output AS output,
    SpanAttributes AS attributes
FROM analytics.spans
WHERE SpanKind = 'GENERATION';

-- Feedback and other scores on traces (thumbs up/down arrive here). The app
-- puts the reason in metadata['tag'] (packages/api/src/langfuse/feedback.ts)
-- and the reason with any text the user typed in comment.
CREATE VIEW analytics.feedback
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    id AS score_id,
    trace_id,
    timestamp AS time,
    name,
    value,
    string_value,
    data_type,
    source,
    metadata['tag'] AS tag,
    ifNull(comment, '') AS comment,
    CAST(metadata, 'Map(String, String)') AS metadata
FROM default.scores FINAL
WHERE is_deleted = 0;

-- Every event above on one timeline, one row per event, in the column layout
-- HyperDX expects of a log source (Timestamp, ServiceName, SeverityText, Body,
-- LogAttributes). HyperDX's "Usage timeline" source and dashboards read it
-- (otel/hyperdx/provision). ServiceName says where the event came from: `ui`
-- (browser), `chat` (a conversation turn, whose Body is the user's message),
-- `llm` (a model call) or `feedback` (a score). Input and Output hold the turn's
-- or model call's content; Reason and Comment the feedback's; StatusMessage why
-- a turn or call failed. TraceId opens the turn in HyperDX's trace viewer
-- (analytics.spans). Scores take their user and conversation from their trace.
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
    '' AS Reason,
    '' AS Comment,
    '' AS Input,
    '' AS Output,
    '' AS StatusMessage,
    toInt64(0) AS TimeToFirstTokenMs,
    '' AS TraceId,
    mapFilter((k, v) -> v != '', map(
        'user_role', user_role, 'route', route, 'from_route', from_route,
        'endpoint', endpoint, 'agent_id', agent_id, 'file_count', file_count
    )) AS LogAttributes
FROM analytics.ui_events
UNION ALL
SELECT
    toDateTime64(c.time, 3),
    'chat',
    multiIf(c.level = 'ERROR', 'error', c.level = 'WARNING', 'warn', 'info'),
    'chat.turn',
    c.input,
    c.user_id,
    c.session_id,
    '',
    toUInt64(0),
    toUInt64(0),
    toUInt64(0),
    toFloat64(0),
    toInt64(c.duration_ms),
    '',
    '',
    '',
    c.input,
    c.output,
    c.status_message,
    toInt64(0),
    c.trace_id,
    c.attributes
FROM analytics.chat_turns AS c
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
    toInt64(g.duration_ms),
    '',
    '',
    '',
    g.input,
    g.output,
    g.status_message,
    g.time_to_first_token_ms,
    g.trace_id,
    mapUpdate(g.attributes, map('generation_id', g.generation_id, 'generation_name', g.name))
FROM analytics.llm_generations AS g
UNION ALL
SELECT
    f.time,
    'feedback',
    if(f.name = 'user-feedback' AND f.value = 0, 'warn', 'info'),
    multiIf(f.name != 'user-feedback', concat('score.', f.name), f.value = 1, 'feedback.thumbs_up', 'feedback.thumbs_down'),
    multiIf(
        f.name != 'user-feedback', concat('score.', f.name, ' ', toString(f.value)),
        concat(if(f.value = 1, 'feedback.thumbs_up', 'feedback.thumbs_down'), if(f.comment != '', concat(' ', f.comment), ''))
    ),
    ifNull(t.user_id, ''),
    ifNull(t.session_id, ''),
    '',
    toUInt64(0),
    toUInt64(0),
    toUInt64(0),
    toFloat64(0),
    toInt64(0),
    multiIf(f.name != 'user-feedback', ifNull(f.string_value, toString(f.value)), f.value = 1, 'thumbsUp', 'thumbsDown'),
    f.tag,
    f.comment,
    '',
    '',
    '',
    toInt64(0),
    ifNull(f.trace_id, ''),
    mapUpdate(
        mapFilter((k, v) -> v != '', f.metadata),
        mapFilter((k, v) -> v != '', map('score_id', f.score_id, 'score_name', f.name, 'score_source', toString(f.source)))
    )
FROM analytics.feedback AS f
LEFT JOIN analytics.llm_traces AS t ON t.trace_id = f.trace_id;
