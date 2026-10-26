(() => {
  const $ = (id) => document.getElementById(id);
  const connection = $("connection");
  const transcript = $("transcript");
  const transcriptEmpty = $("transcript-empty");
  const micButton = $("mic-button");
  const judgeToggle = $("judge-toggle");
  const callsList = $("calls-list");
  const entries = new Map();
  let openCalls = [];
  let judgeSuggestions = [];
  let activeJury = null;
  let recognition;
  let wantsMic = false;
  let restartTimer;
  let toastTimer;
  let socket;
  let retryDelay = 500;

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function renderEntries() {
    for (const child of [...transcript.querySelectorAll(".entry")]) child.remove();
    const recent = [...entries.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-200);
    transcriptEmpty.hidden = recent.length > 0;
    $("entry-count").textContent = `${recent.length} entr${recent.length === 1 ? "y" : "ies"}`;
    for (const entry of recent) {
      const row = document.createElement("article");
      row.className = "entry";
      const time = document.createElement("time");
      time.className = "entry-time";
      time.dateTime = new Date(entry.timestamp).toISOString();
      time.dataset.timestamp = String(entry.timestamp);
      time.textContent = ageLabel(entry.timestamp);
      const source = document.createElement("span");
      source.className = `entry-source ${entry.source === "event" ? "event" : ""}`;
      source.textContent = entry.source === "event" ? "EVENT" : entry.source === "chat" ? "CHAT" : "YOU";
      const text = document.createElement("span");
      text.className = "entry-text";
      text.textContent = entry.text;
      row.append(time, source, text);
      transcript.append(row);
    }
    transcript.scrollTop = transcript.scrollHeight;
  }

  function addEntry(entry) {
    pruneEntries();
    if (!entry || !Number.isInteger(entry.id) || entries.has(entry.id)) return;
    if (entry.timestamp < Date.now() - 5 * 60 * 1000 || entry.timestamp > Date.now() + 60_000) return;
    entries.set(entry.id, entry);
    renderEntries();
  }

  function pruneEntries() {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of entries) {
      if (entry.timestamp < now - 5 * 60 * 1000 || entry.timestamp > now + 60_000) {
        entries.delete(id);
        changed = true;
      }
    }
    if (changed) renderEntries();
  }

  function refreshEntryTimes() {
    for (const time of transcript.querySelectorAll(".entry-time[data-timestamp]")) {
      time.textContent = ageLabel(Number(time.dataset.timestamp));
    }
  }

  setInterval(() => { pruneEntries(); refreshEntryTimes(); }, 10_000);

  function renderCalls() {
    for (const card of [...callsList.querySelectorAll(".call-card")]) card.remove();
    $("calls-empty").hidden = openCalls.length > 0;
    $("open-count").textContent = `${openCalls.length} OPEN`;
    for (const call of openCalls) {
      const card = document.createElement("article");
      card.className = "call-card";
      const top = document.createElement("div");
      top.className = "call-card-top";
      const number = document.createElement("span");
      number.className = "call-number";
      number.textContent = `CALL #${call.id}`;
      const author = document.createElement("span");
      author.className = "call-author";
      author.textContent = `@${call.viewerLogin}`;
      const boldness = document.createElement("span");
      boldness.className = "call-boldness";
      boldness.textContent = `BOLDNESS ${call.boldness ?? 2}/5`;
      const age = document.createElement("time");
      age.className = "call-age";
      age.textContent = ageLabel(call.createdAt);
      top.append(number, author, boldness, age);
      const quote = document.createElement("p");
      quote.className = "call-text";
      quote.textContent = `“${call.text}”`;
      const suggestion = judgeSuggestions.find((item) => item.callId === call.id);
      if (suggestion) {
        const evidence = document.createElement("div");
        evidence.className = "judge-suggestion";
        const label = document.createElement("strong");
        label.textContent = `JUDGE FLAG · ${Math.round(suggestion.confidence * 100)}%`;
        const reason = document.createElement("blockquote");
        reason.textContent = `“${suggestion.evidence}”`;
        evidence.append(label, reason);
        card.append(top, quote, evidence);
      } else card.append(top, quote);
      const actions = document.createElement("div");
      actions.className = "call-actions";
      for (const [action, label, style] of [["confirm", "Confirm", "confirm"], ["reject", "Reject", "reject"], ["nuke", "Nuke", "nuke"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `action-button ${style}`;
        button.dataset.action = action;
        button.dataset.id = String(call.id);
        button.textContent = label;
        actions.append(button);
      }
      card.append(actions);
      const juryButton = document.createElement("button");
      juryButton.type = "button";
      juryButton.className = "action-button jury-open";
      juryButton.dataset.jury = String(call.id);
      juryButton.textContent = activeJury?.callId === call.id ? "Jury open" : "Open jury";
      juryButton.disabled = Boolean(activeJury);
      card.append(juryButton);
      callsList.append(card);
    }
  }

  function ageLabel(timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
    return minutes < 1 ? "just now" : `${minutes}m ago`;
  }

  function setCalls(calls) {
    openCalls = Array.isArray(calls) ? calls : [];
    const openIds = new Set(openCalls.map((call) => call.id));
    judgeSuggestions = judgeSuggestions.filter((suggestion) => openIds.has(suggestion.callId));
    renderCalls();
  }

  function setJudgeSuggestions(items) {
    const openIds = new Set(openCalls.map((call) => call.id));
    judgeSuggestions = Array.isArray(items) ? items.filter((item) => openIds.has(item.callId)) : [];
    renderCalls();
  }

  function applyState(state) {
    setCalls(state.openCalls);
    setJudgeSuggestions(state.judgeSuggestions);
    activeJury = state.activeJury ?? null;
    renderCalls();
    judgeToggle.checked = Boolean(state.judgeEnabled);
    for (const entry of state.context ?? []) addEntry(entry);
  }

  async function loadState() {
    try {
      const response = await fetch("/api/console/state");
      if (!response.ok) throw new Error();
      applyState(await response.json());
    } catch {
      showToast("Could not load the console state. Is Called It running?");
    }
  }

  function setConnection(online) {
    connection.classList.toggle("online", online);
    connection.querySelector("span").textContent = online ? "Connected" : "Reconnecting";
  }

  function connectSocket() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.addEventListener("open", () => { retryDelay = 500; setConnection(true); void loadState(); });
    socket.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === "state") {
          setCalls(event.openCalls);
          activeJury = event.jury ? { callId: event.jury.callId } : null;
          renderCalls();
        }
        else if (event.type === "jury:start") { activeJury = { callId: event.callId }; renderCalls(); }
        else if (event.type === "jury:end") { activeJury = null; renderCalls(); }
        else if (event.type === "context") addEntry(event.entry);
        else if (event.type === "judge:state") judgeToggle.checked = event.enabled;
        else if (event.type === "judge:suggestions") setJudgeSuggestions(event.suggestions);
      } catch { /* Ignore malformed local events. */ }
    });
    socket.addEventListener("close", () => {
      setConnection(false);
      setTimeout(connectSocket, retryDelay);
      retryDelay = Math.min(8_000, retryDelay * 2);
    });
    socket.addEventListener("error", () => socket.close());
  }

  callsList.addEventListener("click", async (event) => {
    const juryButton = event.target.closest("button[data-jury]");
    if (juryButton) {
      juryButton.disabled = true;
      try {
        const response = await fetch(`/api/jury/${juryButton.dataset.jury}/open`, { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not open the jury.");
        activeJury = result.activeJury ?? { callId: Number(juryButton.dataset.jury) };
        renderCalls();
        showToast(`Jury opened for Call #${juryButton.dataset.jury}.`);
      } catch (error) {
        juryButton.disabled = false;
        showToast(error instanceof Error ? error.message : "Could not open the jury.");
      }
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/calls/${button.dataset.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: button.dataset.action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The call could not be updated.");
      showToast(`Call #${button.dataset.id} updated.`);
      await loadState();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The call could not be updated.");
      button.disabled = false;
    }
  });

  judgeToggle.addEventListener("change", async () => {
    const requested = judgeToggle.checked;
    judgeToggle.disabled = true;
    try {
      const response = await fetch("/api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: requested }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not update judge state.");
      judgeToggle.checked = result.enabled;
      showToast(`Automatic judge ${result.enabled ? "on" : "off"}.`);
    } catch (error) {
      judgeToggle.checked = !requested;
      showToast(error instanceof Error ? error.message : "Could not update judge state.");
    } finally {
      judgeToggle.disabled = false;
    }
  });

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    micButton.disabled = true;
    $("speech-support-note").hidden = false;
    $("mic-help").textContent = "Use Chrome to enable microphone transcription.";
  } else {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => {
      micButton.classList.add("listening");
      micButton.setAttribute("aria-pressed", "true");
      micButton.setAttribute("aria-label", "Stop microphone listening");
      $("mic-title").textContent = "Listening to your mic";
      $("mic-help").textContent = "Final speech results are added to the rolling context window.";
      $("mic-state").textContent = "LIVE";
      $("mic-state").classList.add("on");
    };
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const sentences = result[0].transcript.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [];
        for (const sentence of sentences.map((part) => part.trim()).filter(Boolean)) void sendSentence(sentence);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantsMic = false;
        setMicOff("Chrome blocked mic access. Allow the microphone, then try again.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        showToast(`Speech recognition: ${event.error}.`);
      }
    };
    recognition.onend = () => {
      if (wantsMic) {
        clearTimeout(restartTimer);
        const restart = () => {
          if (!wantsMic) return;
          try { recognition.start(); }
          catch { restartTimer = setTimeout(restart, 1_000); }
        };
        restartTimer = setTimeout(restart, 400);
      } else setMicOff("Start listening to add your speech to the context window.");
    };
    micButton.addEventListener("click", () => {
      if (wantsMic) {
        wantsMic = false;
        clearTimeout(restartTimer);
        recognition.stop();
      } else {
        wantsMic = true;
        try { recognition.start(); } catch { wantsMic = false; showToast("Could not start the microphone. Try again."); }
      }
    });
  }

  function setMicOff(message) {
    micButton.classList.remove("listening");
    micButton.setAttribute("aria-pressed", "false");
    micButton.setAttribute("aria-label", "Start microphone listening");
    $("mic-title").textContent = "Your mic is off";
    $("mic-help").textContent = message;
    $("mic-state").textContent = "OFF";
    $("mic-state").classList.remove("on");
  }

  async function sendSentence(text) {
    const timestamp = Date.now();
    try {
      const response = await fetch("/api/context/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, timestamp }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Transcript could not be saved.");
      addEntry(result.entry);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Transcript could not be saved.");
    }
  }

  connectSocket();
})();
