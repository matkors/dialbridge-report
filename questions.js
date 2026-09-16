// The three questions, asked while the scan runs so the wait does work for us.
// Everything we can measure from Google is about getting found. These two behaviours plus a
// job value are the only way to price what happens to a lead after it arrives, which is the
// gap we actually sell. Answers go into the report and ride along to n8n with the email.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const h = (...args) => window.DialBridgeScan.h(...args);

  const QUESTIONS = [
    {
      key: "afterHours",
      question: "A call comes in while you're on a job, or after hours. What usually happens?",
      options: [
        { value: "answered", label: "Someone answers, any hour", leak: 0 },
        { value: "voicemail", label: "It goes to voicemail", leak: 2 },
        { value: "rings_out", label: "It rings out, no voicemail", leak: 3 },
        { value: "callback_later", label: "I call back when I can, usually later or next day", leak: 2 },
      ],
    },
    {
      key: "quoteFollowUp",
      question: "You send a quote and they go quiet. What happens next?",
      options: [
        { value: "automatic", label: "They get follow-ups automatically until they answer", leak: 0 },
        { value: "call_once", label: "I call or text them once", leak: 1 },
        { value: "when_remember", label: "I follow up when I remember", leak: 2 },
        { value: "nothing", label: "Nothing, they either call back or they don't", leak: 3 },
      ],
    },
    {
      key: "jobValue",
      question: "What's an average job worth to you?",
      options: [
        { value: "under_500", label: "Under $500", low: 300 },
        { value: "500_1500", label: "$500 to $1,500", low: 500 },
        { value: "1500_5000", label: "$1,500 to $5,000", low: 1500 },
        { value: "over_5000", label: "More than $5,000", low: 5000 },
      ],
    },
  ];

  let index = 0;
  const answers = {};

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
        h("h2", { class: "q-title", text: "That's everything we needed." }),
        h("p", { class: "q-note", text: "We're folding your answers into the report now." })
      );
      window.leadAnswers = { ...answers };
      // Persist for the page's report and for the email step to send onward.
      try {
        sessionStorage.setItem("dialbridge_answers", JSON.stringify(answers));
      } catch (err) {
        /* private windows block storage; the in-memory copy still works */
      }
      setTimeout(() => { card.hidden = true; }, 2200);
      return;
    }

    card.replaceChildren(
      h("p", { class: "q-progress", text: progressLabel() }),
      h("h2", { class: "q-title", text: q.question }),
      h("div", { class: "q-options" }, q.options.map((option) => {
        const button = h("button", { class: "q-option", type: "button", text: option.label });
        button.addEventListener("click", () => {
          answers[q.key] = option.value;
          if (typeof option.leak === "number") answers[`${q.key}Leak`] = option.leak;
          if (typeof option.low === "number") answers.jobValueLow = option.low;
          index += 1;
          render();
        });
        return button;
      })),
      h("p", { class: "q-note", text: "Nobody sees these but us, and they change what your report says." })
    );
  }

  function start() {
    const card = $("questions");
    if (!card) return;
    index = 0;
    card.hidden = false;
    render();
  }

  function reset() {
    index = 0;
    for (const key of Object.keys(answers)) delete answers[key];
    window.leadAnswers = null;
    const card = $("questions");
    if (card) {
      card.hidden = true;
      card.replaceChildren();
    }
  }

  window.DialBridgeQuestions = { start, reset, QUESTIONS };
})();
