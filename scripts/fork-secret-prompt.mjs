// Reads a secret from an interactive terminal without echoing it. Secrets are
// never accepted from argv or environment variables, which leak into shell
// history, process listings and child processes.
export const promptHidden = (label, { input = process.stdin, output = process.stderr } = {}) => {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error(
      "A passphrase requires an interactive terminal. Run this from PowerShell or Windows Terminal; Git Bash (mintty) cannot hide input.",
    ));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    output.write(label);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled"));
        if (char === "\u007f" || char === "\b") { value = [...value].slice(0, -1).join(""); continue; }
        if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
};
