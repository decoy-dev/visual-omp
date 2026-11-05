export const proofQuestion = "The proof is ready. Continue with the full render?";

export const proofCommand = `python3 -c "from pathlib import Path; Path('proofs').mkdir(exist_ok=True)" && ffmpeg -hide_banner -y -f lavfi -i testsrc=duration=6:size=320x240:rate=30 -frames:v 1 proofs/frame-1.png && python3 -c "from pathlib import Path; print(Path('proofs/frame-1.png').resolve())"`;

/** Each provider response starts only the next step, so the question blocks the full render. */
export function proofCalls(messages, renderCommand) {
  const calls = messages.flatMap(message => message.tool_calls ?? []);
  const proof = calls.findLast(call => call.function?.name === "bash" && call.function.arguments.includes("proofs/frame-1.png"));
  if (!proof) return [{ name: "bash", args: { command: proofCommand, timeout: 30 }, slow: false }];
  const result = messages.findLast(message => message.role === "tool" && message.tool_call_id === proof.id);
  if (!result || /(?:Error:|failed|exit code [1-9])/i.test(typeof result.content === "string" ? result.content : JSON.stringify(result.content))) return [];
  const ask = calls.findLast(call => call.function?.name === "ask");
  if (!ask) return [{ name: "ask", args: { questions: [{ id: "proof", question: proofQuestion, options: [{ label: "Yes" }, { label: "No" }] }] }, slow: false }];
  const answer = messages.findLast(message => message.role === "tool" && message.tool_call_id === ask.id);
  const text = typeof answer?.content === "string" ? answer.content.trim() : "";
  // omp's single-question response. A timeout, note or interrupted question grants no approval.
  if (text !== "User selected: Yes") return [];
  if (calls.some(call => call.function?.name === "bash" && call.function.arguments.includes("out.mp4"))) return [];
  return [{ name: "bash", args: { command: renderCommand, timeout: 30 }, slow: false }];
}
