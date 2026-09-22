// The three questions, asked as a popup the moment they ask for the report, before the
// scan starts.
// Everything we can measure from Google is about getting found. These two behaviours plus a
// job value are the only way to price what happens to a lead after it arrives, which is the
// gap we actually sell. Answers go into the report and ride along to n8n with the email.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const h = (...args) => window.DialBridgeScan.h(...args);

  // Four questions, and the rule for what earns a slot is: ask only what Google cannot tell
  // us. Response time and quote follow-up are invisible from outside. Job value is
  // invisible. Job volume is invisible, and guessing it was the single worst number in the
  // report: inferred from the five reviews the Places API returns, a junk hauler with 107
  // reviews came out at five jobs a month and "losing $300", which to a real operator reads
  // as proof we do not know their business.
  //
  // The review habit question that used to sit here is gone, because we can already see it:
  // reviews per year and the last ninety days are both computed from their own profile.
  // Asking about the measurable and guessing at the unmeasurable was exactly backwards.
  const QUESTIONS = [
    {
      key: "leadResponse",
      question: "When someone reaches out about a job, what actually happens?",
      options: [
        { value: "within_hour", label: "Every inquiry gets a response within the hour", leak: 0 },
        { value: "same_day", label: "We respond the same day, usually", leak: 1 },
        { value: "when_slammed", label: "It depends how slammed we are", leak: 2 },
        { value: "fall_through", label: "Some fall through and we don't always catch them", leak: 3 },
      ],
    },
    {
      key: "quoteFollowUp",
      question: "You send a quote and they go quiet. What happens next?",
      options: [
        { value: "automatic", label: "They get automatic follow-ups until they respond", leak: 0 },
        { value: "once_or_twice", label: "I follow up once or twice myself", leak: 1 },
        { value: "when_remember", label: "I follow up if I remember", leak: 2 },
        { value: "nothing", label: "Nothing. They call back or they don't", leak: 3 },
      ],
    },
    {
      key: "jobsPerMonth",
      question: "Roughly how many jobs do you do in a normal month?",
      // Bands, because this stays a one-tap question like the other three, and because the
      // error we are fixing is five versus forty, not thirty-eight versus forty-two. The
      // bottom of each band is what the money is calculated on, so the figure on the page
      // is always the conservative reading of what they told us.
      options: [
        { value: "under_10", label: "Fewer than 10", jobs: 6 },
        { value: "10_30", label: "10 to 30", jobs: 10 },
        { value: "30_60", label: "30 to 60", jobs: 30 },
        { value: "over_60", label: "More than 60", jobs: 60 },
      ],
    },
    {
      key: "jobValue",
      question: "What's an average job worth to you?",
      // The bottom of each band, so a money figure is always the conservative reading of
      // what they told us. Never the top, never a midpoint we invented.
      options: [
        { value: "under_1000", label: "Under $1,000", low: 600 },
        { value: "1000_5000", label: "$1,000 to $5,000", low: 1000 },
        { value: "5000_15000", label: "$5,000 to $15,000", low: 5000 },
        { value: "over_15000", label: "More than $15,000", low: 15000 },
      ],
    },
  ];

  let index = 0;
  let onDone = null;
  const answers = {};

  function close() {
    const overlay = $("questionsOverlay");
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("is-locked");
    document.removeEventListener("keydown", onKeyDown);
  }

  // Closing is not skipping: it drops them back to the landing page with no report.
  function cancel() {
    onDone = null;
    close();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") cancel();
  }

  function finish() {
    window.leadAnswers = { ...answers };
    try {
      sessionStorage.setItem("dialbridge_answers", JSON.stringify(answers));
    } catch (err) {
      /* private windows block storage; the in-memory copy still works */
    }
    close();
    const callback = onDone;
    onDone = null;
    if (callback) callback(window.leadAnswers);
  }

  function progressLabel() {
    return `Question ${Math.min(index + 1, QUESTIONS.length)} of ${QUESTIONS.length}`;
  }

  function render() {
    const card = $("questions");
    if (!card) return;
    const q = QUESTIONS[index];

    if (!q) {
      card.replaceChildren(
        h("p", { class: "q-progress", text: "Thanks" }),
        h("h2", { class: "q-title", id: "qHeading", text: "Got it. Building your report around those answers." })
      );
      setTimeout(finish, 900);
      return;
    }

    card.replaceChildren(
      ...[
      h("button", { class: "q-close", type: "button", "aria-label": "Close", text: "×" }),
      h("p", { class: "q-progress", text: progressLabel() }),
      index === 0
        ? h("p", { class: "q-intro", text: "Four quick taps and your report gets built around your answers." })
        : null,
      h("h2", { class: "q-title", id: "qHeading", text: q.question }),
      h("div", { class: "q-options" }, q.options.map((option) => {
        const button = h("button", { class: "q-option", type: "button", text: option.label });
        button.addEventListener("click", () => {
          answers[q.key] = option.value;
          if (typeof option.leak === "number") answers[`${q.key}Leak`] = option.leak;
          if (typeof option.low === "number") answers.jobValueLow = option.low;
          if (typeof option.jobs === "number") answers.jobsPerMonthLow = option.jobs;
          index += 1;
          render();
        });
        return button;
      })),
      index > 0 ? h("button", { class: "link q-back", type: "button", text: "Back" }) : null,
    ].filter(Boolean));
    card.querySelector(".q-close")?.addEventListener("click", cancel);
    card.querySelector(".q-back")?.addEventListener("click", () => {
      index = Math.max(0, index - 1);
      render();
    });
    card.querySelector(".q-option")?.focus();
  }

  // Called by the report button. The scan waits for the callback so the answers are in
  // hand before anything is scored.
  function start(done) {
    const overlay = $("questionsOverlay");
    const card = $("questions");
    if (!overlay || !card) {
      if (done) done({});
      return;
    }
    index = 0;
    onDone = done || null;
    overlay.hidden = false;
    document.body.classList.add("is-locked");
    document.addEventListener("keydown", onKeyDown);
    overlay.onclick = (event) => {
      if (event.target === overlay) cancel();
    };
    render();
  }

  function reset() {
    index = 0;
    for (const key of Object.keys(answers)) delete answers[key];
    window.leadAnswers = null;
    onDone = null;
    close();
    const card = $("questions");
    if (card) card.replaceChildren();
  }

  window.DialBridgeQuestions = { start, reset, QUESTIONS };
})();
