import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const repositoryCount = await prisma.repository.count();

  if (repositoryCount > 0) {
    return;
  }

  // Intentionally empty: repository records require user-provided local paths.
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
