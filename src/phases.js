// How a lesson starts (its gear) and the phases it moves through, with the shortcuts that fit each.

export const GEARS = {
  scratch: { label: "Start from scratch", about: "New to this? Learn it from the foundations up.", phase: "plan",
    tell: "I'm new to this. Don't test what I know beyond one question about my goal: plan, then teach from the foundations." },
  probe: { label: "Find what I know", about: "A few questions first, so the lessons start at your level.", phase: "probe",
    tell: "Start by finding out what I already know." },
  test: { label: "Test me", about: "Already familiar? Find the gaps, then fill them.", phase: "review",
    tell: "I'm already familiar with this. Test me to find my gaps, then teach what I miss." },
};

export const PHASES = { probe: "Probing", plan: "Planning", teach: "Teaching", review: "Reviewing" };

export const SUGGEST = {
  none: [["Find what I know", GEARS.probe.tell], ["Teach me from scratch", GEARS.scratch.tell], ["Test me", GEARS.test.tell]],
  probe: [["Start teaching", "That's enough questions about what I know. Make the plan and start teaching."], ["Test me instead", "Skip ahead and test me on this."]],
  plan: [["Looks good, start", "The plan looks good. Start teaching."], ["Change the plan", "I'd like to change the plan."]],
  teach: [["I don't get it", "I don't understand this yet. Teach it again from a different angle, slower, with an example."], ["Another angle", "Explain that from a different angle."], ["Quiz me", "Quiz me on what we just covered."], ["Test me on everything", "Test me on everything so far."], ["Check what I know", "Pause teaching and check what I already know about what's next."]],
  // "back to teaching" means teach what I just struggled with, not move on: moving on is its own choice
  review: [["Teach me this", "I don't understand this yet. Stop testing and teach me the part I just got wrong, from the start, step by step, before any more questions."], ["Explain my misses", "Explain the ones I got wrong."], ["Next part", "I've got this. Move on to teaching the next part."]],
};

/** The learner's words without the instructions the app added for the tutor (the gear, a handoff note). */
export function learnerWords(text = "") {
  for (const g of Object.values(GEARS)) if (text.endsWith(`\n\n${g.tell}`)) return text.slice(0, -g.tell.length - 2);
  return text.replace(/\n\n\[rTutor: [^\]]*\]$/, "");
}

/** The gear a lesson started in, read from its first message. */
export const gearOf = (first = "") => Object.values(GEARS).find((g) => first.endsWith(g.tell));
