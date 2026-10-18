const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
async function main() {
  const accs = await db.chatAccount.findMany({ select: { username: true, passwordHash: true, legacy: true } });
  let bcryptCount = 0, legacyCount = 0; const problems = [];
  for (const a of accs) {
    const h = a.passwordHash || "";
    if (/^\$2[aby]\$\d{2}\$/.test(h)) bcryptCount++;
    else if (h.startsWith("!legacy:")) legacyCount++;
    else problems.push(a.username + " -> " + JSON.stringify(h.slice(0, 40)));
  }
  console.log("total:", accs.length, "| bcrypt (loggable):", bcryptCount, "| !legacy placeholder:", legacyCount);
  if (problems.length) console.log("PROBLEMS: " + problems.join("; "));
  const veil = await db.chatAccount.findFirst({ where: { username: "Veil" } });
  console.log("Veil pw format ok:", /^\$2[aby]\$\d{2}\$/.test(veil.passwordHash), "| coins:", veil.coins);
}
main().catch(console.error).finally(() => db.$disconnect());
