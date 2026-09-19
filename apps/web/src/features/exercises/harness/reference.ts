/**
 * The reference `runAgent`, and three deliberately broken variants.
 *
 * ## Why these are strings
 *
 * The learner's code is a string: it is typed into a textarea, saved as exercise state,
 * shipped to a worker and compiled there with `new Function`. So the reference has to be
 * a string too, or the acceptance test would not be testing the thing that runs — it
 * would be testing a TypeScript function that never goes near the compiler, the sandbox
 * or the message protocol.
 *
 * ## Why it is not shipped to the browser as the answer
 *
 * It *is* in the bundle — anything in `apps/web/src` is, and pretending otherwise would
 * be security theatre against a learner who can open devtools on their own exercise. The
 * honest version of "keeps the solution out of the starter code" is that nothing renders
 * it and nothing loads it into the editor: the starter is
 * `config.starterCode` from `content/modules/06-harnesses/exercises.json`, and this file
 * is imported only by tests. A learner determined to read it has, at that point, chosen
 * to read it, which is their business.
 *
 * ## What the broken variants are for
 *
 * A check that no wrong answer fails is not a check. Each variant below breaks exactly
 * one property and must fail exactly one check; `apps/web/test/harnessCore.test.ts`
 * asserts the full three-by-four grid, which is the milestone's acceptance test. Getting
 * that isolation is why the scripted model ignores the transcript — see the long comment
 * in `scriptedModel.ts`.
 */

/**
 * A correct loop.
 *
 * It is the same shape as `apps/api/src/model/agentLoop.ts` with the observability, the
 * cancellation and the two extra guardrails removed: call the model, stop when the reply
 * asks for no tools, otherwise execute each call, append one `tool` message per result,
 * and never go round more than `maxIterations` times. The error handling is the whole
 * middle of the function, which is the point lesson 1 makes.
 */
export const REFERENCE_SOLUTION = `async function runAgent(model, tools, userMessage, options) {
  const maxIterations = options.maxIterations;
  const messages = [{ role: 'user', content: userMessage }];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const reply = await model.chat(messages, options.toolDefs);
    const calls = reply.toolCalls || [];

    // The stopping condition is "no tool calls", not "the reply said something".
    if (calls.length === 0) {
      return { finalText: reply.content, messages };
    }

    // The assistant's turn goes in first, tool calls and all, or the tool messages that
    // follow answer a question the transcript never asked.
    messages.push({ role: 'assistant', content: reply.content, toolCalls: calls });

    for (const call of calls) {
      let result;
      try {
        if (call.parseOk === false) {
          throw new Error(
            'the arguments for ' + call.name + ' were not valid JSON: ' + call.rawArgs
          );
        }
        const tool = tools[call.name];
        if (!tool) {
          throw new Error(
            'there is no tool named ' + call.name +
            '. Available: ' + Object.keys(tools).join(', ')
          );
        }
        result = await tool(call.args);
      } catch (error) {
        // Errors are observations. The model gets to see what went wrong and try again.
        result = { error: String((error && error.message) || error) };
      }
      messages.push({
        role: 'tool',
        toolName: call.name,
        content: JSON.stringify(result)
      });
    }
  }

  // Ran out of iterations. Bounded, not crashed, and honest about having no answer.
  return { finalText: '', messages };
}`;

/**
 * Broken #1: the tool result never becomes a `tool` message.
 *
 * It is pushed as a `user` message instead, which is the mistake that *looks* like it
 * works — the text is in the transcript, so a human reading it would understand. The
 * model does not: `tool` is what marks a message as the answer to a call it made, and a
 * `user` message claiming to be a calculator result is something a prompt-injection
 * lesson would use as its example. Fails `appends-tool-message` and nothing else.
 */
export const BROKEN_NO_TOOL_MESSAGE = REFERENCE_SOLUTION.replace(
  `      messages.push({
        role: 'tool',
        toolName: call.name,
        content: JSON.stringify(result)
      });`,
  `      messages.push({ role: 'user', content: JSON.stringify(result) });`,
);

/**
 * Broken #2: no iteration cap.
 *
 * `while (true)` with the same body. Correct on every scenario that terminates, and
 * unusable on the one that does not — which is exactly the quiz question, and exactly
 * why the cap is the one guardrail the exercise checks by name. Fails `max-iterations`.
 */
export const BROKEN_NO_CAP = REFERENCE_SOLUTION.replace(
  '  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {',
  '  while (true) {',
);

/**
 * Broken #3: returns as soon as the model says anything.
 *
 * "The model produced text, so that must be the answer." It is not: a model can narrate
 * what it is about to do *and* ask for a tool in the same turn, and the single-tool
 * scenario does exactly that. This loop appends its tool messages correctly and respects
 * its cap; it just answers `Let me work that out with the calculator.` Fails
 * `terminates`.
 */
export const BROKEN_EARLY_RETURN = REFERENCE_SOLUTION.replace(
  `      messages.push({
        role: 'tool',
        toolName: call.name,
        content: JSON.stringify(result)
      });
    }
  }`,
  `      messages.push({
        role: 'tool',
        toolName: call.name,
        content: JSON.stringify(result)
      });
    }

    if (reply.content && reply.content.trim() !== '') {
      return { finalText: reply.content, messages };
    }
  }`,
);
