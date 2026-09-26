const api = document.querySelector("#api");
const language = document.querySelector("#language");
const status = document.querySelector("#status");
const saved = await chrome.storage.local.get(["apiBase", "language"]);
if (saved.apiBase) api.value = saved.apiBase;
if (saved.language) language.value = saved.language;

document.querySelector("#start").onclick = async () => {
  status.textContent = "Starting…";
  await chrome.storage.local.set({ apiBase: api.value.replace(/\/$/, ""), language: language.value });
  const response = await chrome.runtime.sendMessage({ type: "START_SESSION", apiBase: api.value });
  status.textContent = response?.ok ? "Listening. Open the in-page panel." : response?.error || "Could not start";
};
document.querySelector("#stop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  status.textContent = "Stopped";
};
