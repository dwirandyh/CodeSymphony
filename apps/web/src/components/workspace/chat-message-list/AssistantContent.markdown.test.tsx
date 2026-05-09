import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownBody } from "./AssistantContent";

const MULTI_BLOCK_PLAN = `1. Ubah sumber tanggal UI di daftar kupon scratch.
- Target utama ada di [BaseScratchItemAdapter.kt](/Users/dwirandyh/Work/algostudio/philips-marketing-2019-android/app/src/main/java/com/algostudio/marketingprogram/module/scratch/view/adapter/BaseScratchItemAdapter.kt:110).
- Ganti binding teks \`Dipakai pada ...\` dari \`inactive.updatedAt\` menjadi nilai \`scratch_at\` milik kupon inactive.
- Scope ini hanya untuk kupon dengan \`status == "inactive"\` yang berarti sudah dipakai.

2. Rapikan kontrak data \`scratch_at\` di model.
- File target: [ScratchCouponInactive.kt](/Users/dwirandyh/Work/algostudio/marketingprogram-2019-android/app/src/main/java/com/algostudio/marketingprogram/module/scratch/model/ScratchCouponInactive.kt:33)
- Saat ini \`scratchAt\` bertipe \`Any?\`. Itu berisiko karena formatter \`DateHelper.changeFormatToBahasaTanggaldanBulan(...)\` menerima \`String\`.

3. Tambahkan normalisasi kecil di layer presentasi/UI bila perlu.
- Jika setelah inspeksi payload ternyata format \`scratch_at\` tidak selalu \`yyyy-MM-dd HH:mm:ss\`, jangan langsung pass ke \`DateHelper\`.`;

describe("MarkdownBody ordered lists", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("preserves ordered list start values across split plan sections", () => {
    act(() => {
      root.render(<MarkdownBody content={MULTI_BLOCK_PLAN} />);
    });

    const orderedLists = Array.from(container.querySelectorAll("ol"));
    expect(orderedLists).toHaveLength(3);
    expect(orderedLists[0]?.getAttribute("start")).toBeNull();
    expect(orderedLists[1]?.getAttribute("start")).toBe("2");
    expect(orderedLists[2]?.getAttribute("start")).toBe("3");
  });
});
