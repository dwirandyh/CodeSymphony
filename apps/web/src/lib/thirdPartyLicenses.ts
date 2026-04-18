export type ThirdPartyLicense = {
  id: string;
  name: string;
  license: string;
  sourceUrl: string;
  assetPath?: string;
  copyright: string;
  text: string;
};

export const THIRD_PARTY_LICENSES: ThirdPartyLicense[] = [
  {
    id: "material-icon-theme",
    name: "Material Icon Theme",
    license: "MIT",
    sourceUrl: "https://github.com/material-extensions/vscode-material-icon-theme",
    assetPath: "/material-icon-theme/LICENSE",
    copyright: "Copyright (c) 2025 Material Extensions",
    text: `The MIT License (MIT)

Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
];
