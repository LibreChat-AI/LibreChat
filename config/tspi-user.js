/**
 * TSPI user admin: create chat accounts and set each user's TSPI role and clinic.
 *
 * The TSPI role decides what the chat's TSPI MCP token allows (auth/tspiMcpToken.ts). It is kept
 * only on the user record and is set here by an admin — never from the browser.
 *
 *   npm run tspi-user -- set <email> --role=clinician [--clinic=clinic-001] [--name="Dr A"] [--password] [--admin|--no-admin]
 *                        [--approver|--no-approver] [--platform-admin|--no-platform-admin] [--licence-pending]
 *   npm run tspi-user -- import <file.csv>        # columns: email,role,clinic,name (header row)
 *   npm run tspi-user -- sync-brain [--clinician-approvers]
 *   npm run tspi-user -- show <email>
 *   npm run tspi-user -- list
 *
 * TSPI Brain (M02): with TSPI_BRAIN_URL and TSPI_BRAIN_PROVISIONING_KEY set, `set` and `import` also
 * create or update the user in the TSPI Brain, which decides what each user may do. `sync-brain`
 * does that for every account with a TSPI role (run it once at the M02 cutover);
 * --clinician-approvers gives every clinician approval rights with "licence details pending".
 * --approver lets a clinician approve plans; --platform-admin makes someone a Brain platform admin
 * (clinics, staff, licences, audit). These are separate from --admin (the chat's admin screen).
 *
 * `set` creates a local account when the email is new (a temporary password is generated and
 * printed once unless --password asks for one). For an existing account (e.g. one first created
 * by WorkOS sign-in) it keeps the account and its history, sets the role/clinic, and with
 * --password sets a password so the user can sign in with email and password.
 * `import` does `set` for every row; new accounts and accounts with no password get a printed
 * temporary password. Roles: patient, clinic_staff, clinician, reviewer, auditor, none.
 * --admin / --no-admin give or remove the chat's admin screen (LibreChat role ADMIN / USER); this is
 * separate from the TSPI role.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { registerUser } = require('~/server/services/AuthService');
const { brainProvisioningConfigFromEnv, provisionBrainUser } = require('@librechat/api');
const { askSilentQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

const ROLES = ['patient', 'clinic_staff', 'clinician', 'reviewer', 'auditor'];

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) {
      flags[m[1]] = m[2] === undefined ? true : m[2];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function tempPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

async function hash(password) {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}

async function promptPassword() {
  for (;;) {
    const pw = await askSilentQuestion('New password (min 12 chars): ');
    if (pw.length < 12) {
      console.log('Password must be at least 12 characters.');
      continue;
    }
    const again = await askSilentQuestion('Confirm password: ');
    if (pw !== again) {
      console.log('Passwords do not match.');
      continue;
    }
    return pw;
  }
}

function normalizeRole(value) {
  if (value === undefined) return undefined;
  const role = String(value).trim().toLowerCase();
  if (role === 'none' || role === '') return null;
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown role "${value}". Use one of: ${ROLES.join(', ')}, none`);
  }
  return role;
}

/** Create or update one user. `password`: true = prompt, 'if-missing' = temporary password only
 * when the account has none, undefined = leave the password alone. */
async function setUser({ email, role, clinic, name, password, admin }) {
  email = String(email || '')
    .trim()
    .toLowerCase();
  if (!email.includes('@')) throw new Error(`Invalid email: ${email}`);
  let user = await User.findOne({ email }, '+password');
  let printed = null;

  if (!user) {
    const pw = password === true ? await promptPassword() : tempPassword();
    if (password !== true) printed = pw;
    const local = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '');
    const username = `${local}-${crypto.randomBytes(2).toString('hex')}`;
    const result = await registerUser(
      { email, password: pw, confirm_password: pw, name: name || local, username },
      { emailVerified: true },
    );
    if (result.status !== 200) throw new Error(`Could not create ${email}: ${result.message}`);
    user = await User.findOne({ email });
    console.log(`Created ${email}`);
  } else {
    let pw = null;
    if (password === true) {
      pw = await promptPassword();
    } else if (password === 'if-missing' && !user.password) {
      pw = tempPassword();
      printed = pw;
    }
    const update = {};
    if (pw) {
      update.password = await hash(pw);
      update.passwordVersion = Date.now(); // ends existing sessions
      update.emailVerified = true;
    }
    if (name) update.name = name;
    if (Object.keys(update).length) await User.updateOne({ _id: user._id }, update);
  }

  const tspi = {};
  const unset = {};
  if (role !== undefined) {
    if (role === null) unset.tspiRole = '';
    else tspi.tspiRole = role;
  }
  if (clinic !== undefined) {
    if (clinic === null || clinic === '') unset.tspiClinicId = '';
    else tspi.tspiClinicId = String(clinic).trim();
  }
  const op = {};
  if (Object.keys(tspi).length) op.$set = tspi;
  if (Object.keys(unset).length) op.$unset = unset;
  if (admin !== undefined) {
    op.$set = { ...(op.$set || {}), role: admin ? 'ADMIN' : 'USER' };
  }
  if (Object.keys(op).length) await User.updateOne({ _id: user._id }, op);

  const fresh = await User.findById(user._id).lean();
  console.log(
    `${email}: tspiRole=${fresh.tspiRole || '(none)'} clinic=${fresh.tspiClinicId || '(none)'} chatRole=${fresh.role}` +
      (printed ? `  temporary password: ${printed}` : ''),
  );
  return fresh;
}

/** Push one chat account to the TSPI Brain (skipped when the Brain is not configured). */
async function syncBrain(user, opts = {}) {
  const config = brainProvisioningConfigFromEnv();
  if (!config) {
    console.log('  TSPI Brain: skipped (set TSPI_BRAIN_URL and TSPI_BRAIN_PROVISIONING_KEY)');
    return;
  }
  const out = await provisionBrainUser(user, opts, config);
  const m = out.membership;
  console.log(
    `  TSPI Brain: ${out.created ? 'created' : 'updated'} ${out.user_id}` +
      (out.platform_roles.length ? ` platform=${out.platform_roles.join(',')}` : '') +
      (m ? ` ${m.role}@${m.clinic_code} [${m.capabilities.join(',')}]` : ''),
  );
}

/** --x -> true, --no-x -> false, neither -> undefined. */
function triFlag(flags, name) {
  if (flags[name] === true) return true;
  if (flags[`no-${name}`] === true) return false;
  return undefined;
}

/** --admin -> true, --no-admin -> false, neither -> undefined (leave the chat role alone). */
function parseAdminFlag(flags) {
  if (flags.admin === true) {
    return true;
  }
  if (flags['no-admin'] === true) {
    return false;
  }
  return undefined;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines
    .shift()
    .split(',')
    .map((h) => h.trim().toLowerCase());
  return lines.map((line) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;
  if (!command || !['set', 'import', 'show', 'list', 'sync-brain'].includes(command)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    silentExit(1);
  }
  await connect();
  try {
    if (command === 'list') {
      const users = await User.find({}, 'email name provider role tspiRole tspiClinicId').lean();
      for (const u of users) {
        console.log(
          `${u.email}\t${u.provider}\t${u.role}\t${u.tspiRole || '-'}\t${u.tspiClinicId || '-'}\t${u.name || ''}`,
        );
      }
    } else if (command === 'show') {
      const u = await User.findOne({ email: String(target).toLowerCase() }, '+password').lean();
      if (!u) throw new Error('User not found');
      console.log({
        email: u.email,
        name: u.name,
        provider: u.provider,
        hasPassword: !!u.password,
        tspiRole: u.tspiRole || null,
        tspiClinicId: u.tspiClinicId || null,
        twoFactorEnabled: !!u.twoFactorEnabled,
      });
    } else if (command === 'set') {
      const fresh = await setUser({
        email: target,
        role: normalizeRole(flags.role),
        clinic: flags.clinic === true ? undefined : flags.clinic,
        name: typeof flags.name === 'string' ? flags.name : undefined,
        password: flags.password === true ? true : undefined,
        admin: parseAdminFlag(flags),
      });
      await syncBrain(fresh, {
        approver: triFlag(flags, 'approver'),
        platformAdmin: triFlag(flags, 'platform-admin'),
        licencePending: flags['licence-pending'] === true,
      });
    } else if (command === 'sync-brain') {
      const users = await User.find(
        { tspiRole: { $exists: true, $ne: null } },
        'email name openidId tspiRole tspiClinicId',
      ).lean();
      let failed = 0;
      for (const u of users) {
        const clinician = u.tspiRole === 'clinician';
        try {
          console.log(`${u.email}: tspiRole=${u.tspiRole} clinic=${u.tspiClinicId || '(none)'}`);
          await syncBrain(u, flags['clinician-approvers'] === true && clinician
            ? { approver: true, licencePending: true }
            : {});
        } catch (err) {
          failed += 1;
          console.error(`${u.email}: ${err.message}`);
        }
      }
      console.log(`Synced ${users.length - failed} of ${users.length} accounts to the TSPI Brain.`);
      if (failed) silentExit(1);
    } else if (command === 'import') {
      const rows = parseCsv(fs.readFileSync(target, 'utf8'));
      for (const row of rows) {
        try {
          const fresh = await setUser({
            email: row.email,
            role: normalizeRole(row.role),
            clinic: row.clinic || undefined,
            name: row.name || undefined,
            password: 'if-missing',
          });
          await syncBrain(fresh);
        } catch (err) {
          console.error(`${row.email}: ${err.message}`);
        }
      }
    }
    silentExit(0);
  } catch (err) {
    console.error('Error: ' + err.message);
    silentExit(1);
  }
})();
