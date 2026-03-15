import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const fallbackSiteUrl = "https://theunfairwheel.uk";
const siteUrl = (globalThis.process?.env.VITE_SITE_URL || fallbackSiteUrl).replace(
  /\/+$/,
  "",
);

const files = [
  {
    path: resolve("public/robots.txt"),
    content: `User-agent: *
Allow: /
Disallow: /groups/

Sitemap: ${siteUrl}/sitemap.xml
`,
  },
  {
    path: resolve("public/sitemap.xml"),
    content: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
  },
];

for (const file of files) {
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.content, "utf8");
}
