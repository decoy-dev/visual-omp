export function isolationHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Process isolation fixture</title></head>
<body>
<h1>Process isolation fixture</h1>
<p>This test deliberately blocks the preview process until the stage closes.</p>
<p id="isolation-status" role="status">Scripts have not run.</p>
<button id="isolation-busy" type="button">Start busy loop</button>
<script>
const status = document.querySelector("#isolation-status");
status.textContent = "Ready. Origin: " + self.origin;
document.querySelector("#isolation-busy").addEventListener("click", () => {
  status.textContent = "Busy loop starting.";
  console.log("VOMP_ISOLATION_BUSY_STARTING");
  // Let the click return and the status paint before blocking this renderer.
  setTimeout(() => { console.log("VOMP_ISOLATION_BUSY_STARTED"); while (true) {} }, 100);
}, { once: true });
</script>
</body>
</html>
`;
}
