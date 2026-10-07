/**
 * Provisions HyperDX's usage views into every HyperDX team: the sources in
 * sources.json, the saved searches in searches.json and the dashboards in
 * dashboards/. All three are matched by name, so a re-run updates them in place.
 *
 * HyperDX applies DEFAULT_SOURCES only to a team that has no sources yet, and
 * its own dashboard provisioner needs the team's source ids, which differ per
 * installation. So the files name their source ("Usage timeline"), their
 * connection ("ClickHouse") and the sources a source links to (its
 * traceSourceId, logSourceId, ...), and this script resolves those names per
 * team.
 *
 * Runs on the HyperDX image (terraform/hyperdx.tf, and the
 * hyperdx-provision service in docker-compose.override.yml), with HyperDX's own
 * models and validation. Input is HYPERDX_PROVISION (the files as one JSON
 * document: { sources, searches, dashboards }) or HYPERDX_PROVISION_DIR.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILD = '/app/packages/api/build';
const { connectDB, mongooseConnection } = require(`${BUILD}/models`);
const Team = require(`${BUILD}/models/team`).default;
const Connection = require(`${BUILD}/models/connection`).default;
const Dashboard = require(`${BUILD}/models/dashboard`).default;
const { Source } = require(`${BUILD}/models/source`);
const { SavedSearch } = require(`${BUILD}/models/savedSearch`);
const { readDashboardFiles, syncDashboards } = require(`${BUILD}/tasks/provisionDashboards`);
const { SourceSchema } = require('/app/node_modules/@hyperdx/common-utils/dist/types');

/** Fields of a source that link it to another source, by id. */
const SOURCE_LINKS = ['logSourceId', 'traceSourceId', 'metricSourceId', 'sessionSourceId'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadInput() {
  if (process.env.HYPERDX_PROVISION) {
    return JSON.parse(process.env.HYPERDX_PROVISION);
  }
  const dir = process.env.HYPERDX_PROVISION_DIR;
  if (!dir) {
    throw new Error('HYPERDX_PROVISION or HYPERDX_PROVISION_DIR is required');
  }
  const dashboardsDir = path.join(dir, 'dashboards');
  return {
    sources: readJson(path.join(dir, 'sources.json')),
    searches: readJson(path.join(dir, 'searches.json')),
    dashboards: fs
      .readdirSync(dashboardsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => readJson(path.join(dashboardsDir, file))),
  };
}

async function upsertSource(teamId, definition) {
  const connection = await Connection.findOne({ team: teamId, name: definition.connection });
  if (!connection) {
    throw new Error(`Source "${definition.name}": the team has no connection named "${definition.connection}"`);
  }
  const fields = { ...definition, connection: connection._id.toString() };
  const parsed = SourceSchema.safeParse({ ...fields, id: 'provisioned' });
  if (!parsed.success) {
    throw new Error(`Source "${definition.name}" is invalid: ${JSON.stringify(parsed.error.issues)}`);
  }

  const existing = await Source.findOne({ team: teamId, name: definition.name });
  if (existing && existing.kind !== definition.kind) {
    throw new Error(`Source "${definition.name}" exists as a ${existing.kind} source, not ${definition.kind}`);
  }
  const Model = Source.discriminators[definition.kind];
  if (existing) {
    await Model.updateOne({ _id: existing._id }, { $set: { ...fields, team: teamId } }, { runValidators: true });
    return existing._id.toString();
  }
  const created = await Model.create({ ...fields, team: teamId });
  return created._id.toString();
}

function resolveSource(sourceIds, name, where) {
  const id = sourceIds.get(name);
  if (!id) {
    throw new Error(`${where} refers to source "${name}", which the team does not have`);
  }
  return id;
}

/** The dashboard as HyperDX stores it: every source name replaced by the team's id. */
function withSourceIds(dashboard, sourceIds) {
  const where = `Dashboard "${dashboard.name}"`;
  return {
    ...dashboard,
    filters: (dashboard.filters ?? []).map((filter) => ({
      ...filter,
      source: resolveSource(sourceIds, filter.source, where),
    })),
    tiles: dashboard.tiles.map((tile) => ({
      ...tile,
      config: tile.config.source
        ? { ...tile.config, source: resolveSource(sourceIds, tile.config.source, where) }
        : tile.config,
    })),
  };
}

async function provisionDashboards(teamId, dashboards, sourceIds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperdx-dashboards-'));
  try {
    dashboards.forEach((dashboard, index) => {
      fs.writeFileSync(path.join(dir, `${index}.json`), JSON.stringify(withSourceIds(dashboard, sourceIds)));
    });
    // HyperDX's own reader validates each file and skips (with a warning) any it
    // rejects; a skipped dashboard is a bug in the files, so fail instead.
    const valid = readDashboardFiles(dir);
    if (valid.length !== dashboards.length) {
      throw new Error(`${dashboards.length - valid.length} dashboard file(s) failed HyperDX's validation; see the warnings above`);
    }
    await syncDashboards(teamId, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const names = dashboards.map((dashboard) => dashboard.name);
  const stored = await Dashboard.countDocuments({ team: teamId, provisioned: true, name: { $in: names } });
  if (stored !== names.length) {
    throw new Error(`Only ${stored} of ${names.length} dashboards were stored; see the errors above`);
  }
}

async function upsertSearch(teamId, search, sourceIds) {
  const fields = {
    ...search,
    source: resolveSource(sourceIds, search.source, `Saved search "${search.name}"`),
    team: teamId,
  };
  await SavedSearch.updateOne({ team: teamId, name: search.name }, { $set: fields }, { upsert: true, runValidators: true });
}

async function findSourceIds(teamId) {
  const sources = await Source.find({ team: teamId }, { name: 1 }).lean();
  return new Map(sources.map((source) => [source.name, source._id.toString()]));
}

async function provisionTeam(teamId, input) {
  // Sources link to each other by id, so they are written first without their
  // links, then again with each linked source's name resolved to its id.
  const unlinked = (definition) =>
    Object.fromEntries(Object.entries(definition).filter(([key]) => !SOURCE_LINKS.includes(key)));
  for (const definition of input.sources) {
    await upsertSource(teamId, unlinked(definition));
  }
  const sourceIds = await findSourceIds(teamId);
  for (const definition of input.sources) {
    const links = SOURCE_LINKS.filter((key) => definition[key] != null);
    if (links.length === 0) {
      continue;
    }
    const where = `Source "${definition.name}"`;
    await upsertSource(teamId, {
      ...definition,
      ...Object.fromEntries(links.map((key) => [key, resolveSource(sourceIds, definition[key], where)])),
    });
  }

  for (const search of input.searches) {
    await upsertSearch(teamId, search, sourceIds);
  }
  await provisionDashboards(teamId, input.dashboards, sourceIds);
}

async function main() {
  const input = loadInput();
  await connectDB();
  try {
    const teams = await Team.find({}, { _id: 1 }).lean();
    if (teams.length === 0) {
      console.log('No HyperDX team yet: register the first account, then run this again');
      return;
    }
    for (const team of teams) {
      await provisionTeam(team._id.toString(), input);
    }
    console.log(
      `Provisioned ${input.sources.length} source(s), ${input.searches.length} saved search(es) and ` +
        `${input.dashboards.length} dashboard(s) into ${teams.length} team(s)`,
    );
  } finally {
    await mongooseConnection.close();
  }
}

main().catch((error) => {
  console.error(`Failed to provision HyperDX: ${error.message}`);
  process.exit(1);
});
