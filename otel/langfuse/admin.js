/**
 * Sets the password of Langfuse's bootstrapped admin to LANGFUSE_INIT_USER_PASSWORD.
 * Langfuse's LANGFUSE_INIT_* bootstrap only creates that user, so without this a
 * rotated secret holds a password the existing admin does not have.
 *
 * Run as a one-off ECS task on the Langfuse web image (terraform/langfuse.tf),
 * which ships the Prisma client for its own database and the bcryptjs library it
 * hashes passwords with; the hash below matches Langfuse's own (bcryptjs, cost 12).
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const COST = 12;

/** bcryptjs is bundled into Langfuse's server build, so it resolves only from pnpm's store. */
function loadBcrypt() {
  const store = '/app/node_modules/.pnpm';
  const dir = fs.readdirSync(store).find((name) => name.startsWith('bcryptjs@'));
  if (!dir) {
    throw new Error(`bcryptjs is not in ${store}; the Langfuse image layout has changed`);
  }
  return require(path.join(store, dir, 'node_modules', 'bcryptjs'));
}

async function main() {
  const { LANGFUSE_INIT_USER_EMAIL, LANGFUSE_INIT_USER_PASSWORD } = process.env;
  if (!LANGFUSE_INIT_USER_EMAIL || !LANGFUSE_INIT_USER_PASSWORD) {
    throw new Error('LANGFUSE_INIT_USER_EMAIL and LANGFUSE_INIT_USER_PASSWORD are required');
  }

  const bcrypt = loadBcrypt();
  const email = LANGFUSE_INIT_USER_EMAIL.toLowerCase();
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log('No Langfuse admin yet; Langfuse creates it with this password when it starts');
      return;
    }
    if (user.password && (await bcrypt.compare(LANGFUSE_INIT_USER_PASSWORD, user.password))) {
      console.log('Langfuse admin password already matches the secret');
      return;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(LANGFUSE_INIT_USER_PASSWORD, COST) },
    });
    console.log('Updated the Langfuse admin password');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Failed to sync the Langfuse admin password: ${error.message}`);
  process.exit(1);
});
