/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type { Severity } from '../config'
import type { Finding, LaneResult } from '../verdict'

/**
 * What one card needs to draw itself and to act when pressed.
 *
 * `onFix`, `onExplain` and `onDismiss` are the three things a person can do
 * with a finding; they are supplied by the `ui.render` hook in
 * `register.ts`, which owns every mods API call they make.
 * `explanation` is the text an earlier press of explain produced, drawn
 * under the body when it is there.
 */
export type Card = {
  finding: Finding
  explanation: string
  isExplaining: boolean
  isBlocking: boolean
  onFix: () => void
  onExplain: () => void
  onDismiss: () => void
}

/**
 * Everything drawn above the prompt in one pass.
 *
 * `held` is how many findings were ranked but not drawn, counted on the last
 * row so a person knows the panel is holding more. `lanes` is drawn only
 * under the debug option, and is the only place a lane that failed is
 * visible — a failed lane is otherwise indistinguishable from a clean one,
 * which is the distinction worth paying a row for when diagnosing.
 */
export type Panel = {
  cards: readonly Card[]
  held: number
  lanes: readonly LaneResult[]
  isDebug: boolean
  columns: number
}

/**
 * The colour a severity is drawn in.
 *
 * Only the two severities that can hold a turn get a warm colour, so that
 * the panel's colour means "this one can stop you" rather than merely
 * "this one exists".
 */
const INK: Readonly<Record<Severity, string>> = {
  critical: 'red',
  high: 'yellow',
  medium: 'cyan',
  low: 'gray',
}

/**
 * The widest a card's text is wrapped to, whatever the terminal gives,
 * because a finding read across a very wide terminal is harder to scan than
 * one wrapped to a column.
 */
const MAX_COLUMNS = 96

/**
 * The panel above the prompt, or `undefined` when there is nothing to draw.
 *
 * Returned by the `ui.render` hook on `AbovePrompt`, which draws this
 * instead of calling `next` when it has cards, and calls `next` when it does
 * not. An empty panel must be `undefined` rather than an empty box, so that
 * a session with no findings has no band at all.
 *
 * @param ui the element table `$.ui.resolve(e)` handed the hook
 * @param panel the cards, the held count, and the lane results
 * @returns the tree, or `undefined` when there is nothing to show
 */
export function panelOf(
  ui: ElementTable,
  panel: Panel,
): RenderElement | undefined {
  const { Box, Text } = ui
  const rows: RenderElement[] = []
  const width = Math.max(32, Math.min(MAX_COLUMNS, panel.columns))

  for (const card of panel.cards) {
    rows.push(cardOf(ui, card, width))
  }

  if (panel.held > 0) {
    rows.push(
      <Box key="held" paddingLeft={1}>
        <Text dimColor>
          {`+${panel.held} more finding${panel.held === 1 ? '' : 's'} held · /backseat to list`}
        </Text>
      </Box>,
    )
  }

  if (panel.isDebug) {
    for (const row of laneRows(ui, panel.lanes)) {
      rows.push(row)
    }
  }

  if (rows.length === 0) {
    return undefined
  }

  return (
    <Box key="backseat" flexDirection="column" width={width}>
      {rows}
    </Box>
  )
}

/**
 * One finding as a card: who found it, how bad it is, where it is, what it
 * says, and the three buttons.
 *
 * The lane's name leads the header because the panel's whole claim is that
 * a named reviewer said this, not that the session believes it.
 *
 * @param ui the element table
 * @param card the finding and its handlers
 * @param width the columns the card is wrapped to
 * @returns the card's tree
 */
function cardOf(ui: ElementTable, card: Card, width: number): RenderElement {
  const { Box, Text, Button } = ui
  const finding = card.finding
  const ink = INK[finding.severity]
  const span =
    finding.lineEnd > finding.lineStart
      ? `${finding.lineStart}-${finding.lineEnd}`
      : String(finding.lineStart)

  return (
    <Box
      key={`card-${finding.lane}-${finding.file}-${finding.lineStart}`}
      flexDirection="column"
      borderStyle="round"
      paddingLeft={1}
      paddingRight={1}
      width={width}
    >
      <Box>
        <Text color={ink} bold>
          {`backseat · ${[finding.lane, ...finding.alsoFrom].join(' + ')}`}
        </Text>
        <Text dimColor>{`  ${finding.severity}`}</Text>
        {card.isBlocking ? <Text color="red">{'  holds the turn'}</Text> : null}
      </Box>

      <Box>
        <Text dimColor>{`${finding.file}:${span}`}</Text>
      </Box>

      <Box>
        <Text bold>{fit(finding.title, width - 4)}</Text>
      </Box>

      {finding.body !== finding.title ? (
        <Box>
          <Text wrap="wrap">{fit(finding.body, (width - 4) * 4)}</Text>
        </Box>
      ) : null}

      {finding.reference !== '' ? (
        <Box>
          <Text dimColor>{`about: ${fit(finding.reference, width - 12)}`}</Text>
        </Box>
      ) : null}

      {finding.recommendation !== '' ? (
        <Box>
          <Text color="green">{`→ ${fit(finding.recommendation, (width - 6) * 3)}`}</Text>
        </Box>
      ) : null}

      {card.isExplaining ? (
        <Box>
          <Text dimColor italic>
            {'explaining…'}
          </Text>
        </Box>
      ) : null}

      {card.explanation !== '' ? (
        <Box>
          <Text wrap="wrap" dimColor>
            {card.explanation}
          </Text>
        </Box>
      ) : null}

      {/*
        Lettered, not numbered. A bare digit typed into an empty composer
        presses a band Button, and a digit is how a person answers the
        engine's own question prompt: on a band that stays drawn while the
        session works, `hotkey="1"` makes answering a question press "Fix it"
        and submit the fix as an instruction nobody asked for. A letter is
        pressed only while the band holds the focus.
      */}
      <Box gap={1}>
        <Button key="fix" label="Fix it" hotkey="f" onPress={card.onFix} />
        <Button key="why" label="Explain" hotkey="e" onPress={card.onExplain} />
        <Button
          key="no"
          label="Dismiss"
          hotkey="d"
          plain
          dimColor
          onPress={card.onDismiss}
        />
      </Box>
    </Box>
  )
}

/**
 * One row per lane, under the debug option: its outcome, how long it took,
 * and why it produced nothing when that is the reason it is interesting.
 *
 * @param ui the element table
 * @param lanes every lane's result from the last review
 * @returns the rows, empty when no lane has run yet
 */
function laneRows(
  ui: ElementTable,
  lanes: readonly LaneResult[],
): RenderElement[] {
  const { Box, Text } = ui

  return lanes.map(lane => (
    <Box key={`lane-${lane.lane}`} paddingLeft={1}>
      <Text dimColor>
        {`${lane.lane}: ${lane.outcome}` +
          ` · ${lane.findings.length} finding${lane.findings.length === 1 ? '' : 's'}` +
          ` · ${Math.round(lane.latencyMs)}ms` +
          (lane.detail !== '' ? ` · ${lane.detail}` : '')}
      </Text>
    </Box>
  ))
}

/**
 * Text cut to a column count, with an ellipsis where it was cut.
 *
 * Drawing is capped by the host at 100,000 characters for a whole tree, and
 * a reviewer's body can be long; cutting here keeps one verbose finding from
 * crowding out the ones under it.
 *
 * @param text the text to draw
 * @param columns how many characters it may take
 * @returns the text, cut if it was too long
 */
function fit(text: string, columns: number): string {
  const body = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const limit = Math.max(8, columns)

  return body.length <= limit ? body : `${body.slice(0, limit - 1)}…`
}
