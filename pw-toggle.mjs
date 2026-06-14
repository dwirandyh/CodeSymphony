import { chromium } from "playwright";
const log = (...a) => console.log("PW", ...a);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

// open model selector (trigger shows "Cursor · composer-2.5")
const trigger = page.locator('button:has-text("composer-2.5")').first();
await trigger.click();
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/pw-2-modelopen.png" });

// hover the composer model row to reveal Edit, then click Edit
const editBtn = page.locator('[role="button"]:has-text("Edit")').first();
const composerRow = page.locator('button:has-text("composer-2.5")').last();
await composerRow.hover().catch(() => {});
await page.waitForTimeout(400);
log("edit count", await page.locator('[role="button"]:has-text("Edit")').count());
await editBtn.click({ force: true }).catch((e) => log("edit click err", e.message));
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/pw-3-editor.png" });

const editorPanel = await page.locator('[data-agent-model-panel="editor"]').count();
const fastToggle = await page.locator('[role="switch"]').count();
log("editorPanel", editorPanel, "switches", fastToggle);
const panelText = await page.locator('[data-agent-model-panel="editor"]').innerText().catch(() => "(none)");
log("panelText", JSON.stringify(panelText));
await browser.close();
