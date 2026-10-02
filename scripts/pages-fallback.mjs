// GitHub Pages has no SPA rewrites: a direct visit to /repo/contacts would 404. Serving the app
// as 404.html too lets the router take over any path. .nojekyll stops Pages from running Jekyll.
import { copyFileSync, writeFileSync } from "node:fs";

copyFileSync("dist/index.html", "dist/404.html");
writeFileSync("dist/.nojekyll", "");
console.log("dist/404.html and dist/.nojekyll written");
