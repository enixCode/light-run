import type { LandingData } from 'light-landing-page';

const BASE = '/light-run';

const CODE_HTML = `<span class="k">const</span> res <span class="p">=</span> <span class="k">await</span> <span class="f">fetch</span><span class="p">(</span><span class="s">'http://localhost:8080/run'</span><span class="p">,</span> <span class="p">{</span>
  <span class="n">method</span>: <span class="s">'POST'</span><span class="p">,</span>
  <span class="n">headers</span>: <span class="p">{</span> <span class="s">'content-type'</span>: <span class="s">'application/json'</span><span class="p">,</span> <span class="n">authorization</span>: <span class="s">'Bearer ...'</span> <span class="p">}</span><span class="p">,</span>
  <span class="n">body</span>: <span class="f">JSON.stringify</span><span class="p">(</span><span class="p">{</span>
    <span class="n">image</span>:      <span class="s">'python:3.12-alpine'</span><span class="p">,</span>
    <span class="n">entrypoint</span>: <span class="s">'python main.py'</span><span class="p">,</span>
    <span class="n">files</span>:      <span class="p">{</span> <span class="s">'main.py'</span>: <span class="s">'open("out.json","w").write(...)'</span> <span class="p">}</span><span class="p">,</span>
    <span class="n">extract</span>:    <span class="p">[</span><span class="s">'out.json'</span><span class="p">]</span><span class="p">,</span>
  <span class="p">}</span><span class="p">)</span><span class="p">,</span>
<span class="p">}</span><span class="p">)</span><span class="p">;</span>
<span class="k">const</span> run <span class="p">=</span> <span class="k">await</span> res<span class="p">.</span><span class="f">json</span><span class="p">(</span><span class="p">)</span><span class="p">;</span>
run<span class="p">.</span>status      <span class="c">// succeeded | failed | running | cancelled</span>
run<span class="p">.</span>exitCode    <span class="c">// the container exit code</span>
run<span class="p">.</span>artifacts   <span class="c">// [{ path, bytes, type }] - fetch via /runs/:id/artifacts</span>`;

export const lightRunData: LandingData = {
  githubRepo: 'enixCode/light-run',
  brand: 'light-run',
  nav: [
    { label: 'Primitives', href: '#primitives' },
    { label: 'Quick start', href: '#quick-start' },
    { label: 'Security', href: '#security' },
    { label: 'Ecosystem', href: '#ecosystem' },
    { label: 'Documentation', href: `${BASE}/docs` },
    { label: 'GitHub ->', href: 'https://github.com/enixCode/light-run', primary: true },
  ],
  hero: {
    tag: 'HTTP surface - light-runner',
    headline: (
      <>
        Run code over HTTP,
        <br />
        <span className="shy">on</span> <span className="accent">someone else&apos;s</span> Docker.
      </>
    ),
    lede: (
      <>
        A thin HTTP server around <code>light-runner</code>. POST inline files, an image and an
        entrypoint; it runs them in a container and <em>serves back the exit code, logs and any
        artifacts you asked for.</em> No GitHub fetch, no workflow, no orchestration.
      </>
    ),
    meta: [
      { k: 'Runtime', v: <>Node <span className="sub">&gt;=24</span></> },
      { k: 'Server', v: <>Fastify <span className="sub">+ OTel</span></> },
      { k: 'Wraps', v: <>light-runner <span className="sub">SDK</span></> },
      { k: 'License', v: <>MIT <span className="sub">permissive</span></> },
    ],
    banner: {
      src: `${BASE}/banner.webp`,
      alt: 'A glowing sphere passing through a wireframe gateway above an isolated dark grid, the visual metaphor for code crossing an HTTP boundary into a sandbox.',
      captionLeft: 'Fig. 01 - One request, one container, one grid.',
      captionRight: 'light-run / visual',
    },
  },
  primitives: {
    label: 'what you get',
    heading: (
      <>
        POST code. Get back a <span className="strong">run state</span>, logs, and the artifacts you
        asked for.
      </>
    ),
    items: [
      {
        num: '01 / one endpoint',
        title: (
          <>
            <code>POST /run</code> takes <em>files + image + entrypoint</em>.
          </>
        ),
        body: 'Send inline files, a Docker image and a command. light-run writes them to a tmpdir, runs them in a container via light-runner, and returns a RunState: id, status, exit code, duration, artifacts.',
      },
      {
        num: '02 / pull artifacts',
        title: (
          <>
            Extract any container path, <em>stream it back</em>.
          </>
        ),
        body: 'List container paths in extract; their bytes land in an internal artifact dir, served over GET /runs/:id/artifacts/* with a path-traversal guard. Auto-evicted past a size cap.',
      },
      {
        num: '03 / control the run',
        title: (
          <>
            Stop, pause, resume, or <em>cancel</em>.
          </>
        ),
        body: (
          <>
            Run detached and poll <code>GET /runs/:id</code>, or drive the lifecycle with{' '}
            <code>POST /runs/:id/stop|pause|resume|cancel</code>. Run state is persisted by
            light-runner, the source of truth.
          </>
        ),
      },
      {
        num: '04 / manage networks',
        title: (
          <>
            Create and delete <em>Docker networks</em> over HTTP.
          </>
        ),
        body: 'A remote orchestrator can provision isolated networks (POST /networks), attach runs to them, and sweep orphans (POST /networks/cleanup) - all without shell access to the host.',
      },
    ],
  },
  quickstart: {
    label: 'quick start',
    heading: (
      <>
        One <code>POST</code>, and your container <span className="strong">runs</span>.
      </>
    ),
    side: (
      <>
        <p>
          Start the server (<code>light-run serve</code>), then POST a job. Inline your files, name an
          image, give a command, list what to extract.
        </p>
        <p>Stateless past the artifact directory. No caching, ever.</p>
      </>
    ),
    install: 'npm install -g light-run',
    codeHtml: CODE_HTML,
  },
  security: {
    label: 'security model',
    heading: (
      <>
        <span className="strong">Auth</span> on every route. Isolation inherited from light-runner.
      </>
    ),
    rows: [
      {
        k: 'Bearer auth',
        v: (
          <>
            When a token is configured, <strong>every route except <code>/health</code></strong>{' '}
            requires <code>Authorization: Bearer</code>. No token = open server with a startup warning.
          </>
        ),
      },
      {
        k: 'Path-traversal guard',
        v: (
          <>
            Artifact downloads reject a literal <code>..</code> and assert the resolved path stays
            inside the run&apos;s artifact directory. A container cannot serve files it never wrote.
          </>
        ),
      },
      {
        k: 'Body limit',
        v: (
          <>
            POST bodies are capped (<strong>10 MiB</strong> default, tunable). An oversized upload is
            refused with <code>413</code> before it can grow the heap.
          </>
        ),
      },
      {
        k: 'Tmpdir hygiene',
        v: (
          <>
            Inputs live under <code>os.tmpdir()</code> and are removed the moment the container exits,
            success or failure. Files are Zod-validated: no absolute paths, no <code>..</code> segments.
          </>
        ),
      },
      {
        k: 'Auto-eviction',
        v: (
          <>
            Total artifact bytes are compared to a cap after every run; oldest run dirs are evicted
            until under. Running and just-finished runs are never evicted.
          </>
        ),
      },
      {
        k: 'Inherited isolation',
        v: (
          <>
            Cap drops, PID limits, memory/CPU budgets, isolated networks and the gVisor/Kata runtimes
            are all <strong>light-runner&apos;s job</strong>. Configure them on the runner, not here.
          </>
        ),
      },
    ],
    note: (
      <>
        <strong>Does not cover -</strong> request or result caching. Workload containers are
        non-deterministic; memoization needs workflow-level identity that only{' '}
        <code>light-process</code> has. This layer stays stateless past the artifact directory.
      </>
    ),
  },
  ecosystem: {
    label: 'ecosystem',
    heading: (
      <>
        Three tools. <span className="strong">Each</span> does one thing.
      </>
    ),
    cards: [
      {
        name: 'light-runner',
        title: 'Spawn one container, return exit code and files.',
        body: 'The execution primitive. Domain-agnostic, zero orchestration. light-run calls down to this for every job.',
        repo: 'enixCode/light-runner',
      },
      {
        name: 'light-run',
        current: true,
        title: 'CLI and HTTP surface around light-runner.',
        body: 'Point a POST endpoint at it, pipe bodies through, fetch artifacts back. Stateless wrapper, same defaults, same guarantees.',
        repo: 'enixCode/light-run',
      },
      {
        name: 'light-process',
        title: 'DAG orchestration, retries, fan-out.',
        body: 'When one container is not enough. Composes runs into pipelines with backoff, concurrency limits, and structured outputs. Talks to light-run over HTTP.',
        repo: 'enixCode/light-process',
      },
    ],
  },
  footer: {
    sig: 'One request crosses the boundary. One container answers. The rest is up to the code inside.',
    links: [
      { label: 'API', href: `${BASE}/docs/api` },
      { label: 'GitHub', href: 'https://github.com/enixCode/light-run' },
      { label: 'npm', href: 'https://www.npmjs.com/package/light-run' },
      { label: 'Security', href: '#security' },
      { label: 'MIT', href: 'https://github.com/enixCode/light-run/blob/main/LICENSE' },
    ],
    metaLeft: 'light-run // http surface',
    metaRight: 'built with cc',
  },
};
