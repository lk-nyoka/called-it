import { createPlaybackQueue } from "./playbackQueue.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const juryCard = $("jury-card");
  const calledCard = $("called-card");
  const capCard = $("cap-card");
  const leaderboardCard = $("leaderboard-card");
  const recapCard = $("recap-card");
  const tickerCall = $("ticker-call");
  const tickerIndex = $("ticker-index");
  const connectionState = $("connection-state");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const testMode = new URLSearchParams(location.search).get("test") === "1";
  let openCalls = [];
  let callIndex = 0;
  let activeJury = null;
  let juryTicker;
  let demoTimer;
  let pointsFrame;
  let socket;
  let retryDelay = 500;
  let audioContext;
  try { audioContext = new AudioContext(); } catch { audioContext = undefined; }

  const playback = createPlaybackQueue((event) => {
    if (!event) showOnly(null);
    else if (event.type === "jury:start") showJury(event);
    else if (event.type === "called-it") showCalled(event);
    else if (event.type === "hall-of-cap") showCap(event);
    else if (event.type === "leaderboard") showLeaderboard(event);
    else if (event.type === "session:recap") showRecap(event);
  }, { "called-it": 5_000, "hall-of-cap": 3_000, leaderboard: 8_000, "session:recap": 12_000 });

  function showOnly(card) {
    for (const item of [juryCard, calledCard, capCard, leaderboardCard, recapCard]) item.hidden = !card || item !== card;
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
    const durationMs = event.durationMs ?? 10_000;
    const elapsed = Math.max(0, Date.now() - (event.queuedAt ?? Date.now()));
    const remainingMs = Math.max(0, durationMs - elapsed);
    if (!remainingMs) { playback.finish("jury:start", event.callId); return; }
    activeJury = { ...event, durationMs, startedAt: Date.now() - (durationMs - remainingMs) };
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
    activeJury = null;
    clearInterval(juryTicker);
    $("called-viewer").textContent = `@${event.viewerLogin}`;
    $("called-quote").textContent = `“${event.callText}”`;
    $("called-age").textContent = `called ${event.calledAgo}`;
    animatePoints(Number(event.points) || 0);
    calledCard.classList.remove("celebrating");
    void calledCard.offsetWidth;
    calledCard.classList.add("celebrating");
    showOnly(calledCard);
    playCalledSound();
  }

  function animatePoints(target) {
    cancelAnimationFrame(pointsFrame);
    const output = $("called-points");
    if (reducedMotion) { output.textContent = String(target); return; }
    const startedAt = performance.now();
    const duration = 1_100;
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      output.textContent = String(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) pointsFrame = requestAnimationFrame(tick);
    };
    output.textContent = "0";
    pointsFrame = requestAnimationFrame(tick);
  }

  function showCap(event) {
    activeJury = null;
    clearInterval(juryTicker);
    $("cap-viewer").textContent = `@${event.viewerLogin}`;
    $("cap-quote").textContent = `“${event.callText}”`;
    showOnly(capCard);
    playCapSound();
  }

  function showLeaderboard(event) {
    const list = $("leaderboard-list");
    list.replaceChildren();
    (event.leaders ?? []).forEach((leader, index) => {
      const row = document.createElement("li");
      row.textContent = `${index + 1}. @${leader.viewerLogin} · ${leader.points} pts`;
      list.append(row);
    });
    if (!list.children.length) {
      const row = document.createElement("li");
      row.textContent = "No prophets yet. Be the first to call it!";
      list.append(row);
    }
    showOnly(leaderboardCard);
  }

  function showRecap(event) {
    const recap = event.recap ?? {};
    $("recap-correct-name").textContent = recap.boldestCorrect ? `@${recap.boldestCorrect.viewer_login} · ${recap.boldestCorrect.boldness}/5 boldness` : "No confirmed calls";
    $("recap-correct-call").textContent = recap.boldestCorrect ? `“${recap.boldestCorrect.text}” · ${recap.boldestCorrect.points_awarded} pts` : "";
    $("recap-cap-name").textContent = recap.biggestCap ? `@${recap.biggestCap.viewer_login} · ${recap.biggestCap.boldness}/5 boldness` : "No capped calls";
    $("recap-cap-call").textContent = recap.biggestCap ? `“${recap.biggestCap.text}”` : "";
    $("recap-prophet-name").textContent = recap.topProphet ? `@${recap.topProphet.viewer_login}` : "No points yet";
    $("recap-prophet-points").textContent = recap.topProphet ? `${recap.topProphet.points} points this session` : "";
    showOnly(recapCard);
  }

  function handleEvent(event) {
    switch (event.type) {
      case "state":
        setOpenCalls(event.openCalls);
        if (event.jury) playback.enqueue({ type: "jury:start", ...event.jury, queuedAt: Date.now() });
        break;
      case "jury:start": playback.enqueue({ ...event, queuedAt: Date.now() }); break;
      case "jury:update":
        playback.update(event);
        updateJury(event);
        break;
      case "jury:end":
        if (playback.finish("jury:start", event.callId)) {
          clearInterval(juryTicker);
          activeJury = null;
        }
        break;
      case "called-it": playback.enqueue(event); break;
      case "hall-of-cap": playback.enqueue(event); break;
      case "leaderboard": playback.enqueue(event); break;
      case "session:recap": playback.enqueue(event); break;
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
        playback.enqueue({ type: "jury:start", callId: 21, viewerLogin: "pixelprophet", callText: calls[0].text, durationMs: 10_000, receipts: 3, cap: 1, queuedAt: Date.now() });
        let tally = 0;
        const votes = setInterval(() => {
          tally++;
          updateJury({ callId: 21, receipts: 3 + tally, cap: 1 + (tally > 2 ? 1 : 0) });
          if (tally >= 3) clearInterval(votes);
        }, 2_000);
        demoTimer = setTimeout(() => {
          playback.finish("jury:start", 21);
          playback.enqueue({ type: "called-it", viewerLogin: calls[0].viewerLogin, callText: calls[0].text, calledAgo: "14m ago", points: 40 });
          playback.enqueue({ type: "hall-of-cap", viewerLogin: calls[2].viewerLogin, callText: calls[2].text });
          playback.enqueue({ type: "leaderboard", leaders: [{ viewerLogin: "pixelprophet", points: 40 }, { viewerLogin: "chatoracle", points: 20 }] });
          playback.enqueue({ type: "session:recap", recap: {
            boldestCorrect: { viewer_login: "pixelprophet", text: calls[0].text, boldness: 5, points_awarded: 40 },
            biggestCap: { viewer_login: calls[2].viewerLogin, text: calls[2].text, boldness: 4 },
            topProphet: { viewer_login: "pixelprophet", points: 40 },
          } });
          demoTimer = setTimeout(() => {
            callIndex = (callIndex + 1) % openCalls.length;
            updateTicker();
            cycle();
          }, 28_000);
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
