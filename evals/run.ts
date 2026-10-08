import { RUNNABLE_CASES } from "./cases";
import { blockedCases, runScriptedSuite } from "./suite";

/** The scripted suite: no network, no browser. Exit code 1 when any oracle fails or any mutation slips through. */
async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const runs = (await runScriptedSuite()).filter((r) => only.length === 0 || only.includes(r.policy.caseId));
  const lines: string[] = [];
  for (const evalCase of RUNNABLE_CASES) {
    const forCase = runs.filter((r) => r.policy.caseId === evalCase.id);
    if (forCase.length === 0) continue;
    lines.push(`\n${evalCase.id}  (${evalCase.title})`);
    for (const run of forCase) {
      const { policy, result } = run;
      const failed = result.outcomes.filter((o) => !o.pass).map((o) => o.id);
      const label = policy.kind === "oracle" ? "solves" : "caught ";
      lines.push(`  ${run.ok ? "ok  " : "FAIL"} ${policy.kind}:${policy.id.padEnd(18)} score ${result.score.toFixed(2)}  ${label}${failed.length ? ` failing: ${failed.join(", ")}` : ""}`);
      for (const problem of run.problems) lines.push(`         ! ${problem}`);
    }
  }
  for (const blocked of blockedCases()) lines.push(`\nBLOCKED ${blocked.id}: ${blocked.blocked}`);
  const bad = runs.filter((r) => !r.ok);
  lines.push(`\n${runs.length - bad.length}/${runs.length} policy runs behaved as declared${bad.length ? `; ${bad.length} did not` : ""}.`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
