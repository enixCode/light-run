import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export const revalidate = false;

// Deployed site root (domain + basePath). Page urls from the source are
// root-relative (`/docs/...`), so prefixing with this yields absolute,
// followable URLs as the llms.txt spec recommends.
const SITE = 'https://enixcode.github.io/light-run';

const SUMMARY =
  'A thin HTTP server wrapping the light-runner SDK. POST inline files, an image and ' +
  'an entrypoint; light-run writes them to a tmpdir, runs them in a Docker container, ' +
  'and serves the extracted artifacts over HTTP. Stateless past the artifact directory.';

export function GET() {
  const body = llms(source)
    .index()
    // Spec: the H1 is the project name, followed by an optional blockquote summary.
    .replace(/^# Docs\n*/, `# light-run\n\n> ${SUMMARY}\n\n## Docs\n\n`)
    // Make every internal link an absolute, deployed URL.
    .replace(/\]\((\/[^)]+)\)/g, `](${SITE}$1)`);

  return new Response(body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
