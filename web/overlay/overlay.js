(() => {
  const $ = (id) => document.getElementById(id);
  const juryCard = $("jury-card");
  const calledCard = $("called-card");
  const capCard = $("cap-card");
  const tickerCall = $("ticker-call");
  const tickerIndex = $("ticker-index");
  const connectionState = $("connection-state");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const testMode = new URLSearchParams(location.search).get("test") === "1";
  let openCalls = [];
  let callIndex = 0;
  let activeJury = null;
  let juryTicker;
  let displayTimer;
  let demoTimer;
  let socket;
  let retryDelay = 500;
  let audioContext;
  try { audioContext = new AudioContext(); } catch { audioContext = undefined; }

  function showOnly(card) {
    for (const item of [juryCard, calledCard, capCard]) item.hidden = item !== card;
  }

  function updateTicker() {
    if (!openCalls.length) {
      tickerCall.textContent = "Waiting for the first prediction…";
      tickerIndex.textContent = "0 / 0";
      return;
    }
    callIndex %= openCalls.length;
    const call = openCalls[callIndex];
    tickerCall.textContent = `“${call.text}”`;
    tickerIndex.textContent = `${callIndex + 1} / ${openCalls.length}`;
  }

  function setOpenCalls(calls) {
    openCalls = Array.isArray(calls) ? calls : [];
    callIndex = openCalls.length ? callIndex % openCalls.length : 0;
    updateTicker();
  }

  function showJury(event) {
    clearTimeout(displayTimer);
    const durationMs = event.durationMs ?? 10_000;
    activeJury = { ...event, durationMs, startedAt: Date.now() - Math.max(0, durationMs - (event.remainingMs ?? durationMs)) };
    $("jury-call").textContent = `“${event.callText}”`;
    $("receipt-count").textContent = String(event.receipts ?? 0);
    $("cap-count").textContent = String(event.cap ?? 0);
    showOnly(juryCard);
    updateJuryClock();
    clearInterval(juryTicker);
    juryTicker = setInterval(updateJuryClock, 100);
  }

  function updateJuryClock() {
    if (!activeJury) return;
    const remaining = Math.max(0, activeJury.durationMs - (Date.now() - activeJury.startedAt));
    $("jury-time").textContent = `${(remaining / 1000).toFixed(1)}s`;
    $("timer-fill").style.transform = `scaleX(${remaining / activeJury.durationMs})`;
    if (!remaining) {
      clearInterval(juryTicker);
      activeJury = null;
      juryCard.hidden = true;
    }
  }

  function updateJury(event) {
    if (!activeJury || event.callId !== activeJury.callId) return;
    $("receipt-count").textContent = String(event.receipts);
    $("cap-count").textContent = String(event.cap);
  }

  function playTone(frequency, start, duration, type, peak) {
    if (!audioContext) return;
    const audio = audioContext;
    void audio.resume().catch(() => {});
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, audio.currentTime + start);
    gain.gain.setValueAtTime(0.0001, audio.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(peak, audio.currentTime + start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + start + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(audio.currentTime + start);
    oscillator.stop(audio.currentTime + start + duration + 0.03);
  }

  window.addEventListener("pointerdown", () => { if (audioContext?.state === "suspended") void audioContext.resume(); });

  function playCalledSound() {
    if (reducedMotion) return;
    try {
      playTone(660, 0, .32, "triangle", .08);
      playTone(880, .13, .38, "triangle", .07);
      playTone(1320, .26, .55, "sine", .06);
    } catch { /* Audio can be unavailable in a browser source; visuals still work. */ }
  }

  function playCapSound() {
    if (reducedMotion) return;
    try {
      playTone(190, 0, .22, "sawtooth", .05);
      playTone(125, .15, .34, "triangle", .05);
    } catch { /* Audio can be unavailable in a browser source; visuals still work. */ }
  }

  function showCalled(event) {
    clearTimeout(displayTimer);
    activeJury = null;
    clearInterval(juryTicker);
    $("called-viewer").textContent = `@${event.viewerLogin}`;
    $("called-quote").textContent = `“${event.callText}”`;
    $("called-age").textContent = `called ${event.calledAgo}`;
    $("called-points").textContent = String(event.points);
    showOnly(calledCard);
    playCalledSound();
    displayTimer = setTimeout(() => { calledCard.hidden = true; }, 8_000);
  }

  function showCap(event) {
    clearTimeout(displayTimer);
    activeJury = null;
    clearInterval(juryTicker);
    $("cap-viewer").textContent = `@${event.viewerLogin}`;
    $("cap-quote").textContent = `“${event.callText}”`;
    showOnly(capCard);
    playCapSound();
    displayTimer = setTimeout(() => { capCard.hidden = true; }, 7_000);
  }

  function handleEvent(event) {
    switch (event.type) {
      case "state":
        setOpenCalls(event.openCalls);
        if (event.jury) showJury({ type: "jury:start", ...event.jury });
        break;
      case "jury:start": showJury(event); break;
      case "jury:update": updateJury(event); break;
      case "jury:end":
        if (activeJury?.callId === event.callId) {
          clearInterval(juryTicker);
          activeJury = null;
          juryCard.hidden = true;
        }
        break;
      case "called-it": showCalled(event); break;
      case "hall-of-cap": showCap(event); break;
    }
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      retryDelay = 500;
      connectionState.classList.add("connected");
      connectionState.classList.remove("visible");
    });
    socket.addEventListener("message", (message) => {
      try { handleEvent(JSON.parse(message.data)); } catch { /* Ignore malformed local events. */ }
    });
    socket.addEventListener("close", () => {
      connectionState.classList.remove("connected");
      connectionState.classList.add("visible");
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(8_000, retryDelay * 2);
    });
    socket.addEventListener("error", () => socket.close());
  }

  function runDemo() {
    const calls = [
      { id: 21, viewerLogin: "pixelprophet", text: "The boss drops a legendary item", createdAt: Date.now() - 14 * 60_000 },
      { id: 22, viewerLogin: "chatoracle", text: "Lindo says no way before the next round", createdAt: Date.now() - 6 * 60_000 },
      { id: 23, viewerLogin: "criticallyonline", text: "The next chest is a mimic", createdAt: Date.now() - 2 * 60_000 },
    ];
    setOpenCalls(calls);
    const cycle = () => {
      demoTimer = setTimeout(() => {
        showJury({ type: "jury:start", callId: 21, viewerLogin: "pixelprophet", callText: calls[0].text, durationMs: 10_000, receipts: 3, cap: 1 });
        let tally = 0;
        const votes = setInterval(() => {
          tally++;
          updateJury({ callId: 21, receipts: 3 + tally, cap: 1 + (tally > 2 ? 1 : 0) });
          if (tally >= 3) clearInterval(votes);
        }, 2_000);
        demoTimer = setTimeout(() => {
          activeJury = null;
          clearInterval(juryTicker);
          juryCard.hidden = true;
          showCalled({ viewerLogin: calls[0].viewerLogin, callText: calls[0].text, calledAgo: "14m ago", points: 40 });
          demoTimer = setTimeout(() => {
            showCap({ viewerLogin: calls[2].viewerLogin, callText: calls[2].text });
            demoTimer = setTimeout(() => {
              capCard.hidden = true;
              callIndex = (callIndex + 1) % openCalls.length;
              updateTicker();
              cycle();
            }, 7_000);
          }, 8_000);
        }, 10_000);
      }, 2_000);
    };
    cycle();
  }

  setInterval(() => {
    if (openCalls.length > 1) {
      callIndex = (callIndex + 1) % openCalls.length;
      updateTicker();
    }
  }, 6_000);

  if (testMode) runDemo();
  else connect();
})();
