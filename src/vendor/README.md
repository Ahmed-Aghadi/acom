# Bundled Markdown renderer

The unmodified browser UMD distribution from `markdown-it@15.0.3` is vendored locally. It requires no npm install, build step, CDN, external runtime downloads, or plugins.

| Included component | Version | License |
| --- | --- | --- |
| markdown-it | 15.0.3 | MIT |
| mdurl | 2.1.0 | MIT |
| uc.micro | 3.0.0 | MIT |
| entities | 8.1.0 | BSD-2-Clause |
| linkify-it | 6.1.0 | MIT |
| punycode.js | 2.3.1 | MIT |

`argparse` is CLI-only and is not included. Full licenses, including mdurl's Joyent/Node attribution, are in `NOTICES.txt`.

The binary embeds both the parser and notices, serving only the fixed `/assets/markdown-it-15.0.3.min.js` and `/assets/markdown-NOTICES.txt` paths. The script tag uses the SRI digest below; tests check both digests against the exact vendored bytes. The UI wrapper limits input, token count and nesting, preserving the full source as plain text if parsing is unavailable or exceeds those limits.

Source: [official npm tarball](https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz), member `package/dist/browser/markdown-it.umd.min.js` (100,786 bytes).

- File SHA-256: `391f2aa638e75e6c7859d0a5c5650ef0956722a45998f17e05b83bc655778e1e`
- File SRI: `sha384-ARStLecQmtLYjBgfD3+w+irhiSoLTnFk/ne6c0gRWQKQtC9791ZLMQ9D3OaBISt3`
- Tarball integrity: `sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`

Review on 2026-10-23 verified registry signatures and SHA-512 integrity for all six packages. Dependency versions and integrity matched the [release lockfile](https://github.com/markdown-it/markdown-it/blob/15.0.3/package-lock.json). The bundle's source map matched all 54 parser files against the official release tag and all 13 dependency inputs against their pinned published packages. Source review found no dynamic code evaluation, DOM/storage access, or network APIs. No package lifecycle scripts were run.

The official npm advisory check returned no advisories for these exact versions on that date. Version 15.0.3 fixes both [multiline reference parsing DoS](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c) and [HTML parsing DoS](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-vfgh-jcmw-g37q). Recheck advisories and repeat integrity/source/license review before updates; do not use floating versions or automatic downloads.

Registry signatures establish artifact consistency, not freedom from malicious or vulnerable code. This package has no registry publish-provenance attestation, and the bundle was not independently rebuilt. Keep the application renderer's raw HTML, images, automatic bare-URL linkification, and typographer disabled, restrict link schemes, and bound parsing input. The [upstream safety guidance](https://github.com/markdown-it/markdown-it/blob/15.0.3/docs/safety.md) explains the HTML-disabled security model.
