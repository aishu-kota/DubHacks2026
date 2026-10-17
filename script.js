(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const setupPanel = $("setup-panel");
  const sessionPanel = $("session-panel");
  const alertPanel = $("alert-panel");
  const simulatedPanel = $("simulated-panel");
  const setupForm = $("setup-form");

  const intervalInput = $("interval");
  const displayNameInput = $("display-name");
  const contactNameInput = $("contact-name");

  const timerValue = $("timer-value");
  const timerCaption = $("timer-caption");
  const timerSubtext = $("timer-subtext");
  const progressFill = $("progress-fill");
  const statusMessage = $("status-message");
  const sessionTitle = $("session-title");
  const greeting = $("greeting");
  const sessionStep = $("session-step");
  const sessionFootnote = document.querySelector(".session-footnote");

  const graceValue = $("grace-value");
  const alertCopy = $("alert-copy");
  const notificationTitle = $("notification-title");
  const notificationBody = $("notification-body");

  const safeButton = $("safe-button");
  const stopButton = $("stop-button");
  const graceSafeButton = $("grace-safe-button");
  const showAlertButton = $("show-alert-button");
  const restartButton = $("restart-button");

  const GRACE_SECONDS = 20;
  let sessionDuration = Number(intervalInput.value);
  let deadline = null;
  let graceDeadline = null;
  let intervalId = null;
  let mode = "setup";
  let displayName = "";
  let contactName = "";

  function showOnly(panel) {
    [setupPanel, sessionPanel, alertPanel, simulatedPanel].forEach((item) => {
      item.hidden = item !== panel;
    });
  }

  function formatTime(totalSeconds) {
    const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function clearTicker() {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  }

  function startTicker() {
    clearTicker();
    tick();
    intervalId = window.setInterval(tick, 250);
  }

  function startSession() {
    clearTicker();
    sessionDuration = Number(intervalInput.value);
    displayName = displayNameInput.value.trim();
    contactName = contactNameInput.value.trim();
    deadline = Date.now() + sessionDuration * 1000;
    graceDeadline = null;
    mode = "active";

    sessionPanel.classList.remove("is-warning");
    sessionTitle.textContent = displayName ? `You're all set, ${displayName}.` : "You're on your way.";
    greeting.textContent = "Your next check-in is coming up.";
    sessionStep.textContent = "SESSION ACTIVE";
    timerCaption.textContent = "TIME UNTIL CHECK-IN";
    timerSubtext.textContent = "Tap the button when you're safe.";
    statusMessage.textContent = "Your check-in timer is running.";
    safeButton.hidden = false;
    stopButton.textContent = "End demo session";
    showOnly(sessionPanel);
    startTicker();
  }

  function checkIn() {
    if (mode !== "active" && mode !== "grace") return;
    deadline = Date.now() + sessionDuration * 1000;
    graceDeadline = null;
    mode = "active";
    sessionPanel.classList.remove("is-warning");
    sessionTitle.textContent = displayName ? `Glad you're safe, ${displayName}.` : "Check-in complete.";
    greeting.textContent = "Your timer has been reset.";
    sessionStep.textContent = "CHECK-IN COMPLETE";
    timerCaption.textContent = "TIME UNTIL NEXT CHECK-IN";
    timerSubtext.textContent = "You're back on track.";
    statusMessage.textContent = "✓ Check-in received. Your timer has restarted.";
    showOnly(sessionPanel);
    startTicker();
  }

  function enterGracePeriod() {
    mode = "grace";
    graceDeadline = Date.now() + GRACE_SECONDS * 1000;
    sessionPanel.classList.remove("is-warning");
    alertCopy.textContent = "We didn't receive a check-in. This demo gives you a short grace period before displaying a simulated contact alert.";
    showOnly(alertPanel);
    startTicker();
  }

  function showSimulatedAlert() {
    clearTicker();
    mode = "simulated";
    const recipient = contactName || "your trusted contact";
    notificationTitle.textContent = "A check-in was missed";
    notificationBody.textContent = `Demo only: this is what a message to ${recipient} could look like. No message or location was sent.`;
    showOnly(simulatedPanel);
  }

  function tick() {
    if (mode === "active") {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      timerValue.textContent = formatTime(remaining);
      progressFill.style.width = `${Math.max(0, Math.min(100, (remaining / sessionDuration) * 100))}%`;

      if (remaining <= 0) {
        enterGracePeriod();
      }
    } else if (mode === "grace") {
      const remaining = Math.max(0, (graceDeadline - Date.now()) / 1000);
      graceValue.textContent = formatTime(remaining);
      if (remaining <= 0) {
        showSimulatedAlert();
      }
    }
  }

  function endSession() {
    clearTicker();
    mode = "setup";
    deadline = null;
    graceDeadline = null;
    showOnly(setupPanel);
  }

  setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    startSession();
  });

  safeButton.addEventListener("click", checkIn);
  graceSafeButton.addEventListener("click", checkIn);
  stopButton.addEventListener("click", endSession);
  showAlertButton.addEventListener("click", showSimulatedAlert);
  restartButton.addEventListener("click", () => {
    endSession();
    displayNameInput.focus();
  });

  // Keep the prototype honest: it does not send messages, request location,
  // contact emergency services, or monitor the user outside this open page.
})();
