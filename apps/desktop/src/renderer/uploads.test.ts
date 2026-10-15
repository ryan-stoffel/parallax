import { expect, test } from "vite-plus/test";

import { encodedImage, isImagePath, splitFiles, withFiles } from "./uploads";

test("splitFiles takes back what withFiles added, and leaves other text alone (PLX-779)", () => {
  const paths = ["/u/1/paper v3.pdf", "/u/2/notes.md"];
  expect(splitFiles(withFiles("Summarize this.\n\nThanks", paths))).toEqual({
    text: "Summarize this.\n\nThanks",
    paths,
  });
  expect(splitFiles(withFiles("", paths))).toEqual({ text: "", paths });
  expect(splitFiles("Attached files: none")).toEqual({ text: "Attached files: none", paths: [] });
  const written = "See below.\n\nAttached files:\n- report.pdf";
  expect(splitFiles(written)).toEqual({ text: written, paths: [] });
  expect(splitFiles(withFiles("", ["C:\\up\\a.pdf"])).paths).toEqual(["C:\\up\\a.pdf"]);
});

test("an image is saved as image-<n> with its type's extension, and only those read as images (PLX-799)", () => {
  const { name } = encodedImage({ mediaType: "image/jpeg", data: "" }, 2);
  expect(name).toBe("image-2.jpg");
  expect(isImagePath(`/u/1/${name}`)).toBe(true);
  expect(isImagePath("C:\\up\\1\\image-1.webp")).toBe(true);
  expect(isImagePath("/u/1/my-image-1.png")).toBe(false);
  expect(isImagePath("/u/1/image-1.pdf")).toBe(false);
});
