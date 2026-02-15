import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
    const existing = await prisma.workflow.findFirst({ where: { name: "Example approval workflow" } });
    if (existing) {
        return;
    }
    await prisma.workflow.create({
        data: {
            name: "Example approval workflow",
            steps: {
                create: [
                    {
                        order: 0,
                        title: "Summarize task",
                        kind: "prompt",
                        prompt: "Summarize the objective in 3 bullet points.",
                    },
                    {
                        order: 1,
                        title: "Human approval",
                        kind: "approval",
                        prompt: null,
                    },
                    {
                        order: 2,
                        title: "Produce final plan",
                        kind: "prompt",
                        prompt: "Produce the final execution plan in markdown.",
                    },
                ],
            },
        },
    });
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
//# sourceMappingURL=seed.js.map