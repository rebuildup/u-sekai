# Vision

> Status: durable conceptual product / research vision.
>
> This document records the thesis of u-sekai. It is intentionally **not** an architecture specification. Current releases make concrete implementation choices, recorded in ADRs and `docs/architecture.md`; those choices may evolve without becoming permanent product-identity commitments.

## 1. Why u-sekai exists

As implementation becomes cheaper and faster with stronger software agents, the bottlenecks in product development move outward.

Generating a design or implementation can increasingly be parallelized and repeated. The harder problems become:

- deciding what is worth trying,
- exposing the resulting product to realistic use,
- discovering behavior that was not anticipated by the author,
- and evaluating experience when there is no single correct answer.

Conventional automated testing remains necessary, but it primarily verifies known expectations. A fixed E2E suite asks whether a predefined path still works. It cannot, by itself, tell us how an unfamiliar person will explore a product, what they will misunderstand, what they will ignore, what they will remember, or whether they will trust the result.

u-sekai explores a different question:

> What happens when many independent artificial users, each limited by a different body of perception, action, memory, and context, are placed into a digital environment they do not already understand?

The project aims to make that question repeatable enough to become part of a development loop.

## 2. The product is the benchmark target, not the agent

Most browser / computer-use benchmarks hold an environment and task definition fixed, then measure how capable an agent is at completing the task.

u-sekai is interested in the inverse direction.

The reasoning agent is an instrument. The **digital product** is what we want to study.

The experiment therefore should not primarily ask:

> Can this agent complete task X?

It should ask questions such as:

- What does this user try first?
- What do they think the product does?
- Which controls do they notice or fail to notice?
- Which wrong model of the interface do they form?
- Where do they hesitate, repeat, retreat, or abandon?
- What workarounds do they invent?
- What do they believe happened after an action?
- How confident are they?
- Would they want to use the product again?
- How does a changed product alter the distribution of these behaviors?

Task completion can be useful evidence, but it is only one observation among many.

## 3. Synthetic Users are not personas acting out a prompt

A central thesis of u-sekai is that a powerful model cannot be made into a credible novice, impaired user, distracted user, or unfamiliar user merely by instructing it to behave as one.

A prompt such as:

> You are bad at computers. Act like a beginner.

does not remove knowledge that the model already has. It does not prevent the model from reading every instruction, recalling a learned interface convention, using a tool unavailable to a real user, or reasoning around an impairment it was only told to imagine.

The project therefore distinguishes **reasoning ability** from **user capability**.

A useful conceptual decomposition is:

```text
Synthetic User
=
Reasoner
+ Perception boundary
+ Action boundary
+ Memory boundary
+ Situation / motivation
+ Mental state / preference
```

The Reasoner may remain highly capable.

The simulation fidelity comes primarily from controlling what the Reasoner can actually perceive, do, and retain.

## 4. Capability must be enforced, not role-played

Capability constraints should be real properties of the experiment whenever feasible.

Examples:

- A user who cannot distinguish certain colors should receive a transformed visual observation, not an instruction to pretend colors are indistinguishable.
- A user with poor pointer precision should have imprecise or restricted input available, rather than being asked to intentionally misclick.
- A touch-only user should not receive hover or right-click operations.
- A user who does not know keyboard shortcuts should not receive a shortcut-oriented action interface.
- A user with limited retained memory should not receive the complete historical trajectory on every reasoning step.
- A user who cannot see hidden labels should not receive DOM metadata that reveals them.

This also means the available tools do not have to be equal across users.

In fact, a uniform high-level automation toolbox is often undesirable because it silently gives every synthetic user the same superpowers.

A future u-sekai experiment may intentionally expose small, limited, almost toy-like input/output capabilities whose shape depends on the user condition being simulated.

The exact tool model is undecided. The principle is more important:

> The runtime should make an unavailable capability unavailable, rather than relying on the agent to voluntarily avoid using it.

## 5. The user should encounter an unknown environment

u-sekai should avoid giving the participant agent privileged knowledge of the tested product.

For exploratory evaluation, useful conditions may include:

- no source code,
- no implementation documentation,
- no hidden element metadata,
- no precomputed product map,
- no explanation of the intended happy path,
- no assumption that the user has read a manual,
- and no guarantee that the user remembers instructions presented earlier.

What the user receives should resemble what that user could actually know from their current situation and prior experience.

The product should have the opportunity to teach the user through the interface itself.

This is necessary for observing discoverability, misconception, learning, forgetting, hesitation, and confidence.

## 6. User stories describe situations, not scripts

A fixed script is useful for deterministic E2E verification:

```text
open settings
click notifications
disable email
save
```

That is not the primary abstraction u-sekai wants to optimize for.

A user story should instead establish why a person is in the environment and what is happening around them.

For example:

```text
You have several things due tomorrow.
You opened this service for the first time because someone recommended it.
You are short on time and are trying to get organized.
```

The story may intentionally leave the correct action, product vocabulary, and even the exact achievable outcome unspecified.

This allows the product to be explored rather than merely executed.

The long-term goal is not to maintain a finite catalog of stories that the product can overfit to. u-sekai should investigate ways to generate fresh populations of situations, histories, capabilities, and motivations while preserving enough structure to compare experiments.

## 7. Diversity should come from constraints and histories, not stereotypes

Demographic labels can be useful context in some research, but they are a poor substitute for the actual differences that affect interaction.

For example, "elderly user" should not automatically imply one fixed digital behavior.

More relevant experimental dimensions may include:

- visual perception,
- contrast sensitivity,
- motor precision,
- device familiarity,
- prior domain knowledge,
- reading behavior,
- attention,
- retained memory,
- willingness to explore,
- risk tolerance,
- trust in automation,
- urgency,
- interruption,
- and past experience with the product.

These dimensions may correlate in real populations, and calibration against real users is an important research problem. However, the simulation should avoid turning broad identity labels into deterministic capability assumptions.

## 8. Mental state is different from capability

Capability and mental state should not be conflated.

Capability answers questions such as:

- Can this user perceive this distinction?
- Can this user perform this action?
- Can this user retain this information?

Mental state and preference answer different questions:

- What does this user currently believe?
- What do they expect?
- What do they want?
- What do they distrust?
- What are they paying attention to?
- How frustrated, hurried, or confident are they?
- What do they prefer?

The project expects some of these states to be maintained or periodically reintroduced by the experiment runtime rather than left entirely to a single long model conversation.

This is especially important because the user may form and retain **incorrect** mental models.

A synthetic participant should be allowed to believe that something was not saved, that an icon means the wrong thing, or that a feature does not exist. The experiment should not automatically repair every misconception simply because the underlying model is capable of inferring the correct answer.

How these states should be represented is still an open design question.

## 9. Forgetting must be possible

Human interaction is not a perfect replay of an ever-growing transcript.

A model that receives every previous observation, instruction, and action at every step has a memory advantage that may dominate the simulation.

u-sekai should investigate explicit memory boundaries, including the possibility of:

- retention,
- decay,
- omission,
- distortion,
- reinforcement,
- and interruption.

The key principle is the same as with perception:

> If an experiment says the participant has forgotten something, the forgotten information should ideally no longer be available to the Reasoner.

The exact memory mechanism remains undecided.

## 10. Subjective experience is first-class evidence

User experience cannot be reduced to success or failure.

A participant may complete a task while feeling uncertain, frustrated, manipulated, or unwilling to return. Another participant may fail to reach an intended state while correctly learning how the product works and feeling confident they could succeed later.

u-sekai therefore treats subjective participant feedback as an important output of an episode.

After an interaction period, the participant may be interviewed about topics such as:

- what they think the product does,
- what they were trying to accomplish,
- what they found difficult or surprising,
- which actions they were unsure about,
- whether the system behaved as expected,
- whether they trust the result,
- what they believe they would remember,
- and whether they would want to use it again.

The participant should answer from the state and memories it actually retained, rather than being given a perfect replay purely to make the interview easier.

This self-report should not be treated as ground truth. It is one observation channel.

## 11. Evaluation needs multiple viewpoints

A useful experiment may contain at least three distinct forms of evidence:

### Participant evidence

What the synthetic user itself reports about the experience.

### Observer evidence

What an independent evaluator infers from the interaction trace, recordings, visible state, and structured experiment data.

### Behavioral / system evidence

What was objectively observed: actions, timing, retries, reversals, errors, state transitions, interruptions, and other measurable events.

Disagreement between these channels is valuable.

Examples:

- the participant reports no confusion, but repeatedly reverses actions,
- the product reaches the expected state, but the participant says they are not confident it worked,
- the observer sees a long hesitation that the participant does not remember,
- the participant likes an interaction that an objective success metric would classify as inefficient.

u-sekai should preserve these disagreements instead of prematurely collapsing them into a single UX score.

## 12. A benchmark should be generative, not a finite checklist

A static benchmark creates a target that can eventually be optimized directly.

That is useful for some kinds of engineering, but dangerous when the goal is discovering unknown user behavior.

The long-term direction for u-sekai is therefore closer to an **experiment generator** than a finite scenario suite.

Conceptually, experiments may vary:

- user capability boundaries,
- prior knowledge,
- history,
- device / environment,
- situation,
- goals or motivations,
- interruptions,
- preferences,
- product state,
- and the Reasoner itself.

Fresh combinations should produce new interaction episodes.

Reproducibility still matters. Seeds, generated conditions, runtime versions, and evidence may need to be recorded so an interesting episode can be replayed or compared. But replayability should not require making the benchmark finite.

## 13. Comparison is more promising than universal scoring

A universal numeric UX score risks encoding one evaluator's local optimum and encouraging the product to overfit to it.

A promising direction is comparative evaluation:

```text
baseline product
      vs
candidate product

under comparable synthetic populations
```

The system could study changes in the distribution of:

- misconceptions,
- subjective preference,
- confidence,
- frustration,
- abandonment,
- exploration patterns,
- unexpected strategies,
- accessibility problems,
- and severe failures.

Blind or partially blind comparison may reduce evaluator bias.

This is a research direction, not a finalized scoring design.

## 14. u-sekai should discover problems, not merely certify known behavior

Deterministic tests are well suited to hard gates such as:

- a contract is satisfied,
- a page renders,
- an API returns the correct result,
- a known workflow does not regress.

u-sekai is aimed at a different layer:

> Generate interaction that the product team did not explicitly specify, then surface meaningful patterns from what happened.

Early versions should therefore be judged by whether they reveal useful unknowns, not by whether they can immediately provide a trustworthy binary release gate.

A likely progression is:

```text
exploration
→ behavioral findings
→ comparative evaluation
→ regression signals
→ optional probabilistic gates
```

The later stages should only be adopted if calibration justifies them.

## 15. The interaction backend is replaceable

The first practical Web experiments may use existing browser automation internally.

That must not define the conceptual model of a Synthetic User.

A browser automation system may provide the low-level bridge to a real browser while the participant itself sees only constrained observations and actions.

Long term, u-sekai should remain compatible with more human-like execution paths, including OS-level or computer-use style interaction, without requiring the core experiment concept to change.

Therefore:

- browser automation technology is an implementation detail,
- privileged automation APIs must not automatically become participant capabilities,
- and the project should avoid designing its public conceptual model around any one driver.

The concrete driver architecture is intentionally undecided.

## 16. Web is the first environment, not the final boundary

Web is a practical starting point because isolated sessions, visual capture, resettable state, and automated interaction are comparatively accessible.

The conceptual model should remain useful for environments such as:

- desktop applications,
- mobile applications,
- creative tools,
- operating-system workflows,
- and other interactive digital systems.

No cross-platform architecture is adopted yet. This is a constraint on premature assumptions, not an implementation requirement for the first milestone.

## 17. Relationship to the larger development loop

u-sekai is motivated by a broader development pattern:

```text
observe the world
      ↓
generate ideas / hypotheses
      ↓
build many candidates
      ↓
expose them to users / simulations
      ↓
observe behavior and experience
      ↓
evaluate
      ↓
generate better hypotheses
      ↺
```

As implementation gets cheaper, the value of this loop shifts toward:

- finding the right problems,
- generating better candidate directions,
- constructing credible environments for evaluation,
- and learning from the resulting evidence.

u-sekai focuses on the **interaction / observation / evaluation** portion of that loop.

A longer-term possibility is that findings produced by u-sekai become inputs to idea generation itself: repeated confusion, unexpected behavior, or unmet needs discovered by synthetic populations may suggest the next product hypotheses to explore.

This is part of the vision, not an initial implementation commitment.

## 18. What u-sekai must not claim

Synthetic Users are not real users.

The project should not claim that an LLM population is representative merely because it is diverse or large.

Known risks include:

- model-specific behavioral bias,
- training-data familiarity with common interfaces,
- excessive rationality,
- artificial language understanding,
- weak simulation of embodied limitations,
- evaluator bias,
- generator bias,
- and benchmark overfitting.

Real-user studies remain necessary when the product decision requires real-human evidence.

A core research responsibility of u-sekai is to determine **where synthetic evaluation is informative and where it is not**.

Calibration against real behavior should be treated as a first-class research problem, not a marketing footnote.

## 19. Current conceptual commitments

The following are the strongest durable conceptual commitments:

1. u-sekai is exploratory UX infrastructure, not a replacement for deterministic E2E testing.
2. The product being tested is the primary evaluation target; the agent is an experimental instrument.
3. Static persona prompting alone is insufficient for credible user simulation.
4. Capability differences should be enforced by the environment whenever feasible.
5. Participant tools and observations may intentionally differ between user conditions.
6. Privileged automation information must not automatically leak into participant perception.
7. Fixed scenario coverage is not the end goal; generated, open-ended episodes are central to the vision.
8. Success / failure is insufficient as a representation of user experience.
9. Participant self-report, independent observation, and behavioral evidence should remain distinguishable.
10. Incorrect beliefs, forgetting, hesitation, and unconventional behavior are valid outcomes to preserve.
11. Any particular browser automation framework is replaceable infrastructure, not the project identity.
12. Synthetic evaluation must expose its limits and eventually be calibrated against real users.

Everything below these principles remains open to research.

## 20. Open design frontier

The current implementation necessarily makes concrete choices, but the following remain open-ended beyond those release-specific decisions:

- the execution architecture,
- the programming language,
- the browser / computer-use driver,
- the agent protocol,
- the model provider or model mix,
- the concrete capability representation,
- how perception transforms are implemented,
- how action constraints are implemented,
- how memory is represented,
- how mental state is injected or updated,
- how generated populations are sampled,
- how stories are generated,
- how application state is isolated or reset,
- what evidence is recorded,
- what an interview schema looks like,
- how observer evaluation works,
- how findings are clustered,
- how baseline / candidate comparison is normalized,
- how real-user calibration is performed,
- what constitutes an MVP,
- and whether any result should eventually become a release gate.

Those questions belong in research Issues and later ADRs.

The purpose of this document is to keep those investigations pointed at the same problem without prematurely choosing their answers.
