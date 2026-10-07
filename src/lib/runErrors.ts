/**
 * Turns what the engine or Instagram wrote into flow_run.error / send_queue.error into a sentence
 * that says what went wrong and what to do about it. Unknown errors keep Instagram's own words.
 */
const RULES: Array<[RegExp, string, boolean?]> = [
  [/empty text|message is empty|param message must be non-empty/i,
    "A message was empty, so Instagram refused it. Write some text or add an image in the message step."],
  [/button link must start/i,
    "A button's link doesn't start with https://, so the message wasn't sent. Fix the link on the button."],
  [/24-hour messaging window is closed|outside of allowed window|sent outside/i,
    "The person hadn't messaged in the last 24 hours, so Instagram doesn't allow messaging them. Nothing to fix: it sends again once they write.", false],
  [/smart delay ends after|delay ends after/i,
    "A wait here ends after the 24-hour window closes, so the run stopped. Shorten the wait to under 24 hours."],
  [/cannot be found|user cannot be messaged|not available|no matching user/i,
    "Instagram couldn't reach this person. They may have deleted their account, blocked you or turned off messages.", false],
  [/already (been )?replied|only one private reply|private reply.*already/i,
    "This comment already got its one private reply. Instagram allows only one per comment.", false],
  [/comment.*(deleted|does not exist)|object with id .* does not exist/i,
    "The comment or post was deleted before the reply went out.", false],
  [/more than \d+ messages|loops|stopped after \d+ steps/i,
    "The automation went round in a loop and was stopped. Check for an arrow that leads back to an earlier step."],
  [/missing from the graph/i,
    "A step was deleted while someone was in the middle of it. Their run stopped there."],
  [/temporarily blocked|deemed abusive|\(#368\)/i,
    "Instagram temporarily blocked sending from the account. Sending paused itself; see Settings › Instagram."],
  [/access token|session has expired|\(#190\)|oauth/i,
    "The Instagram connection expired. Reconnect it in Settings › Instagram."],
  [/rate limit|too many|request limit|\(#(4|17|32|613)\)/i,
    "Instagram's sending limit was reached. Sending slowed down and retried by itself.", false],
  [/permission|\(#10\)|\(#200\)/i,
    "The app isn't allowed to do this yet. Check the permissions granted when connecting Instagram."],
];

export interface RunError {
  text: string;
  /** false: it happens in normal use (window closed, person unreachable) and nothing needs fixing. */
  fixable: boolean;
}

export function explainRunError(raw: string): RunError {
  const msg = raw.trim();
  for (const [re, text, fixable = true] of RULES) if (re.test(msg)) return { text, fixable };
  return { text: `Instagram said: "${msg.slice(0, 160)}"`, fixable: true };
}
