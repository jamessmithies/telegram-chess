// ============================================================
// EMAIL CHESS — Google Apps Script
// ============================================================
// Play correspondence chess via email against Stockfish (hosted
// on Google Cloud Functions). Claude provides optional teaching
// commentary after each move. You reply with your move in
// algebraic notation and the script responds with the engine's
// next move in the same thread.
//
// Commands (must be the first word in your reply):
//   NEW       — start a new game
//   RESIGN    — resign the current game
//   PAUSE     — pause daily emails (e.g. holiday)
//   CONTINUE  — resume after a pause
//
// Quick Setup:
//   1. Deploy the Stockfish Cloud Function (see stockfish-cloud-function/)
//   2. Create a Google Sheet → Extensions → Apps Script → paste this + Chess.gs
//   3. Project Settings → Script Properties:
//        ANTHROPIC_API_KEY  — your key from console.anthropic.com
//        STOCKFISH_URL      — your Cloud Function URL
//        EMAIL              — your email address (optional; defaults
//                             to your Google account email)
//   4. (Optional) Edit CONFIG defaults below (difficulty, color, etc.)
//   5. Run quickStart() — this does everything in one step!
//
// Manual Setup (if you prefer step-by-step):
//   1-3. Same as above
//   4. Run initialiseSheet()
//   5. Run setupTriggers()
//   6. Run startFirstGame()
// ============================================================
// --- CONFIGURATION ---
const CONFIG = {
  ANTHROPIC_API_KEY: PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
  EMAIL: PropertiesService.getScriptProperties().getProperty('EMAIL'),
  STOCKFISH_URL: PropertiesService.getScriptProperties().getProperty('STOCKFISH_URL'),
  DIFFICULTY: 'intermediate',   // beginner | intermediate | advanced
  PLAYER_COLOUR: 'white',       // white | black
  POLL_MINUTES: 5,              // How often to check for email replies
  MODEL: 'claude-haiku-4-5-20251001',  // Updated: haiku is sufficient for commentary and cheaper
  THREAD_LABEL: 'chess-game',   // Gmail label to track the game thread
  AUTO_ARCHIVE: 'smart',        // Options: false, true, 'smart' (archives only when waiting for player)
  THREAD_SEARCH_DAYS: 30,       // How many days back to search for threads
  MAX_PARSE_LINES: 50,          // Maximum lines to parse for moves
  MAX_PARSE_LENGTH: 1000,       // Maximum characters to parse
  MAX_MOVE_LEN: 20,
  MAX_FEN_LEN: 200,
  MAX_COMMENT_LEN: 1500,
  MAX_MOVEHIST_LEN: 6000,
  MIN_CLAUDE_CALL_MS: 2000,  // Minimum time between API calls (2 seconds)
};
const NOTATION_GUIDE = `
---
Algebraic notation quick reference:
Pieces:  K = King, Q = Queen, R = Rook, B = Bishop, N = Knight
         (pawns have no letter — just the square, e.g. e4)
Moves:   Nf3 = knight to f3, Bb5 = bishop to b5
Capture: Nxe5 = knight captures on e5, exd5 = pawn captures on d5
Castle:  O-O = kingside, O-O-O = queenside
Promote: e8=Q = pawn promotes to queen
Check:   + (e.g. Qd7+)  Checkmate: # (e.g. Qf7#)
If two pieces can reach the same square, add the file or rank:
  Rae1 = rook on a-file to e1, R1e2 = rook on rank 1 to e2
`;
// --- UTIL HELPERS ---
function getAccountEmail() {
  const e = (Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!e) throw new Error('Could not determine account email (Session.getEffectiveUser()).');
  return e;
}
function getDestinationEmail() {
  const e = (CONFIG.EMAIL || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!e) throw new Error('Destination email is not set and could not determine account email.');
  return e;
}
function normalizeEmail(fromField) {
  const s = String(fromField || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}
function onlyMeGuard(message) {
  const allowed = getAccountEmail();
  const sender = normalizeEmail(message.getFrom());
  return sender === allowed;
}
function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
function enforceRateLimit(propertyKey, minMs) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = parseInt(props.getProperty(propertyKey) || '0', 10);
  if (last && now - last < minMs) {
    throw new Error(`Rate limited: wait ${Math.ceil((minMs - (now - last)) / 1000)}s and try again.`);
  }
  props.setProperty(propertyKey, String(now));
}
function getOrCreateGameToken() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('CHESS_GAME_TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('CHESS_GAME_TOKEN', token);
  }
  return token;
}
function buildSubject(prefix) {
  const token = getOrCreateGameToken();
  return `${prefix} [chess:${token}]`;
}
function safeTrim(s, maxLen) {
  s = String(s ?? '');
  if (s.length > maxLen) return s.slice(0, maxLen);
  return s;
}
function isValidFen(fen) {
  if (typeof fen !== 'string') return false;
  fen = fen.trim();
  if (!fen || fen.length > CONFIG.MAX_FEN_LEN) return false;
  try {
    const chess = new Chess(fen);
    return true;
  } catch (e) {
    return false;
  }
}
// --- IMPROVED MESSAGE TRACKING ---
// Uses message IDs instead of counts for reliable tracking
function getLastProcessedMessageId() {
  return PropertiesService.getScriptProperties()
    .getProperty('CHESS_LAST_MESSAGE_ID') || '';
}
function setLastProcessedMessageId(messageId) {
  PropertiesService.getScriptProperties()
    .setProperty('CHESS_LAST_MESSAGE_ID', messageId);
}
// --- SMART THREAD DISCOVERY ---
// Finds the game thread even if ID is lost
function findGameThread() {
  const state = getGameState();
  let thread = null;
  // Try 1: Use saved thread ID
  if (state.threadId) {
    try {
      thread = GmailApp.getThreadById(state.threadId);
      if (thread && thread.getMessageCount() > 0) {
        Logger.log('Found thread by saved ID: ' + state.threadId);
        return thread;
      }
    } catch (e) {
      Logger.log('Saved thread ID invalid: ' + e.toString());
    }
  }
  // Try 2: Search by game token and label
  const token = getOrCreateGameToken();
  const searchQueries = [
    `label:${CONFIG.THREAD_LABEL} subject:"[chess:${token}]"`,
    `subject:"[chess:${token}]" newer_than:${CONFIG.THREAD_SEARCH_DAYS}d`,
    `label:${CONFIG.THREAD_LABEL} newer_than:7d`,
  ];
  for (const query of searchQueries) {
    try {
      const threads = GmailApp.search(query, 0, 5);
      if (threads.length > 0) {
        // Get the most recent thread
        thread = threads.reduce((newest, current) =>
          current.getLastMessageDate() > newest.getLastMessageDate() ? current : newest
        );
        // Update saved thread ID
        state.threadId = thread.getId();
        saveGameState(state);
        Logger.log('Found thread by search: ' + query);
        return thread;
      }
    } catch (e) {
      Logger.log('Search failed: ' + query + ' - ' + e.toString());
    }
  }
  Logger.log('No game thread found');
  return null;
}
// --- SMART ARCHIVING HELPER ---
function archiveIfAppropriate(thread, context) {
  if (!thread) return;
  Logger.log(`Archive check: mode=${CONFIG.AUTO_ARCHIVE}, context=${context}`);
  if (CONFIG.AUTO_ARCHIVE === false) {
    return; // Never archive
  }
  if (CONFIG.AUTO_ARCHIVE === true) {
    thread.moveToArchive(); // Always archive
    Logger.log('Archived (always mode)');
    return;
  }
  if (CONFIG.AUTO_ARCHIVE === 'smart') {
    // Smart mode: Archive only when waiting for player
    const archiveContexts = [
      'waiting_for_player',  // Engine has moved, waiting for player
      'game_over',           // Game ended
      'paused',             // Game is paused
    ];
    if (archiveContexts.includes(context)) {
      thread.moveToArchive();
      Logger.log(`Archived (smart mode: ${context})`);
    } else {
      Logger.log(`Not archiving (smart mode: ${context})`);
    }
  }
}
// --- SHEET HELPERS ---
function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('GameState');
}
function getGameState() {
  const sheet = getSheet();
  const rawFen = sheet.getRange('B1').getValue() || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Validate FEN before trusting sheet data
  if (!isValidFen(rawFen)) {
    throw new Error('Invalid FEN in GameState sheet — possible data corruption. Reset the sheet and start a new game.');
  }
  return {
    fen: rawFen,
    moveHistory: sheet.getRange('B2').getValue() || '',
    gameActive: sheet.getRange('B3').getValue() !== false,
    moveNumber: parseInt(sheet.getRange('B4').getValue(), 10) || 1,
    difficulty: sheet.getRange('B5').getValue() || CONFIG.DIFFICULTY,
    playerColour: sheet.getRange('B6').getValue() || CONFIG.PLAYER_COLOUR,
    threadId: sheet.getRange('B7').getValue() || '',
    lastProcessedCount: parseInt(sheet.getRange('B8').getValue(), 10) || 0,
    paused: sheet.getRange('B9').getValue() === true,
  };
}
function saveGameState(state) {
  const sheet = getSheet();
  sheet.getRange('B1').setValue(state.fen);
  sheet.getRange('B2').setValue(state.moveHistory);
  sheet.getRange('B3').setValue(state.gameActive);
  sheet.getRange('B4').setValue(state.moveNumber);
  sheet.getRange('B5').setValue(state.difficulty);
  sheet.getRange('B6').setValue(state.playerColour);
  sheet.getRange('B7').setValue(state.threadId);
  sheet.getRange('B8').setValue(state.lastProcessedCount);
  sheet.getRange('B9').setValue(state.paused);
}
// --- INITIALISE ---
function initialiseSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('GameState');
  if (!sheet) sheet = ss.insertSheet('GameState');
  sheet.getRange('A1').setValue('FEN');
  sheet.getRange('A2').setValue('Move History');
  sheet.getRange('A3').setValue('Game Active');
  sheet.getRange('A4').setValue('Move Number');
  sheet.getRange('A5').setValue('Difficulty');
  sheet.getRange('A6').setValue('Player Colour');
  sheet.getRange('A7').setValue('Thread ID');
  sheet.getRange('A8').setValue('Last Processed Msg Count');
  sheet.getRange('A9').setValue('Paused');
  const state = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: true,
    moveNumber: 1,
    difficulty: CONFIG.DIFFICULTY,
    playerColour: CONFIG.PLAYER_COLOUR,
    threadId: '',
    lastProcessedCount: 0,
    paused: false,
  };
  saveGameState(state);
  let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
  if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
  getOrCreateGameToken();
  Logger.log('Sheet initialised. Run setupTriggers() next.');
}
// --- PREFLIGHT CHECK ---
function validateApiKey() {
  const key = CONFIG.ANTHROPIC_API_KEY;
  if (!key || key === 'YOUR_API_KEY_HERE' || String(key).trim() === '') {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it in Project Settings → Script Properties.');
  }
  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (code === 401) throw new Error('ANTHROPIC_API_KEY is invalid (401 Unauthorized). Check Script Properties.');
  if (code === 403) throw new Error('ANTHROPIC_API_KEY is forbidden (403). The key may be disabled or restricted.');
  if (code === 429) throw new Error('Anthropic API rate-limited during validation (429). Try again shortly.');
  if (code >= 500) {
    Logger.log('Anthropic API returned ' + code + ' during validation — may be temporary. Proceeding.');
    return true;
  }
  if (code >= 200 && code < 300) {
    Logger.log('API key validated successfully.');
    return true;
  }
  const msg = (json && json.error && json.error.message) ? json.error.message : ('HTTP ' + code);
  throw new Error('Unexpected response during API key validation: ' + msg);
}
function validateStockfishUrl() {
  const url = CONFIG.STOCKFISH_URL;
  if (!url || url === 'YOUR_CLOUD_FUNCTION_URL' || String(url).trim() === '') {
    throw new Error('STOCKFISH_URL is not set. Add it in Project Settings → Script Properties.');
  }
  if (!/^https:\/\/.+/.test(url)) {
    throw new Error('STOCKFISH_URL must be an HTTPS URL. Got: ' + url);
  }
  Logger.log('Stockfish URL configured: ' + url);
  const sa = PropertiesService.getScriptProperties().getProperty('STOCKFISH_SA');
  if (!sa || String(sa).trim() === '') {
    throw new Error('STOCKFISH_SA is not set. Add the service account email in Script Properties.');
  }
  if (!sa.includes('@') || !sa.includes('.iam.gserviceaccount.com')) {
    throw new Error('STOCKFISH_SA does not look like a service account email. Expected format: name@project.iam.gserviceaccount.com');
  }
  Logger.log('Stockfish service account configured: ' + sa);
  return true;
}
function preflight() {
  Logger.log('Account email (sender allowlist): ' + getAccountEmail());
  Logger.log('Destination email: ' + getDestinationEmail());
  validateApiKey();
  validateStockfishUrl();
  Logger.log('Preflight passed. Ready to play.');
}
// --- CLAUDE API ---
function callClaude(systemPrompt, userMessage) {
  enforceRateLimit('CHESS_LAST_CLAUDE_CALL_MS', CONFIG.MIN_CLAUDE_CALL_MS);
  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 1024,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Claude API returned non-JSON (HTTP ${code}).`);
  }
  if (code < 200 || code >= 300) {
    const msg = (json && json.error && json.error.message) ? json.error.message : `HTTP ${code}`;
    throw new Error('Claude API error: ' + msg);
  }
  if (json.error) throw new Error('Claude API error: ' + json.error.message);
  if (!json.content || !json.content[0] || typeof json.content[0].text !== 'string') {
    throw new Error('Claude API error: unexpected response shape.');
  }
  return json.content[0].text;
}
function getCommentaryPrompt(state) {
  const difficultyInstructions = {
    beginner: 'The player is a beginner. Explain what the engine\'s move does in plain language. Mention basic concepts like development, controlling the center, or king safety. Keep it encouraging and educational.',
    intermediate: 'The player is intermediate. Give a brief positional or tactical comment about the engine\'s move. Mention ideas like piece activity, pawn structure, or tactical threats.',
    advanced: 'The player is advanced. Give concise analytical commentary. Mention strategic plans, key variations, or positional nuances.',
  };
  return `You are a chess tutor providing commentary on a game between a human player and a chess engine.
You will receive:
- The current position (FEN) after both moves
- The player's move and the engine's response
- The move history
Your job is to comment on the engine's move to help the player learn. Do NOT suggest moves for the player.
Respond with ONLY a JSON object in this exact format, no markdown fencing:
{"comment":"<your commentary on the engine's move>"}
STYLE: ${difficultyInstructions[state.difficulty] || difficultyInstructions.intermediate}
Keep your comment concise (1-3 sentences). Respond ONLY with the JSON object.`;
}
// --- BOARD RENDERING ---
function generateTextBoard(fen) {
  const ranks = fen.split(' ')[0].split('/');
  let board = '';
  for (let i = 0; i < 8; i++) {
    const rankNum = 8 - i;
    let row = rankNum + ' ';
    const rank = ranks[i];
    for (let j = 0; j < rank.length; j++) {
      const ch = rank[j];
      if (ch >= '1' && ch <= '8') {
        for (let k = 0; k < parseInt(ch, 10); k++) row += '. ';
      } else {
        row += ch + ' ';
      }
    }
    board += row + '\n';
  }
  board += '  a b c d e f g h\n';
  return board;
}
// --- STOCKFISH ENGINE ---
/**
 * Fetches an ID token for the Cloud Function via the IAM Credentials API.
 * Gen2 Cloud Functions (Cloud Run) require an ID token, not an access token.
 *
 * Requires:
 *   - STOCKFISH_SA script property (service account email with Cloud Run Invoker role)
 *   - The Apps Script user must have Service Account Token Creator role on that SA
 *   - The Apps Script project must be linked to the same GCP project
 */
function getIdToken(audience) {
  const sa = PropertiesService.getScriptProperties().getProperty('STOCKFISH_SA');
  if (!sa) throw new Error('STOCKFISH_SA is not set. Add the service account email in Script Properties.');
  const tokenUrl = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
    sa + ':generateIdToken';
  const tokenOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    payload: JSON.stringify({
      audience: audience,
      includeEmail: true,
    }),
    muteHttpExceptions: true,
  };
  const resp = UrlFetchApp.fetch(tokenUrl, tokenOptions);
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Failed to get ID token (HTTP ' + code + '): ' + resp.getContentText());
  }
  const json = JSON.parse(resp.getContentText());
  return json.token;
}
function callStockfish(fen, difficulty) {
  const url = CONFIG.STOCKFISH_URL;
  if (!url) throw new Error('STOCKFISH_URL is not set. Add it in Project Settings → Script Properties.');
  const idToken = getIdToken(url);
  const payload = {
    fen: fen,
    difficulty: difficulty || 'intermediate',
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + idToken,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Stockfish API error (HTTP ' + code + '): ' + text);
  }
  const json = JSON.parse(text);
  if (!json.move) throw new Error('Stockfish returned no move.');
  // Validate evaluation shape — discard rather than propagate malformed data
  if (json.evaluation !== undefined) {
    const ev = json.evaluation;
    if (typeof ev !== 'object' || ev === null ||
        !['cp', 'mate'].includes(ev.type) ||
        typeof ev.value !== 'number') {
      Logger.log('Stockfish evaluation shape unexpected — ignoring: ' + JSON.stringify(ev));
      json.evaluation = null;
    }
  }
  return json; // { move: "g1f3", evaluation: { type: "cp", value: 30 } | null }
}
// --- CORE GAME LOGIC ---
function getEngineMove() {
  const state = getGameState();
  if (!state.gameActive) return null;
  Logger.log('Requesting engine move for FEN: ' + state.fen);
  const engineResult = callStockfish(state.fen, state.difficulty);
  const uciMove = engineResult.move;
  Logger.log('Engine returned UCI move: ' + uciMove);
  const chess = new Chess(state.fen);
  let move;
  try {
    move = chess.move({
      from: uciMove.substring(0, 2),
      to: uciMove.substring(2, 4),
      promotion: uciMove.length > 4 ? uciMove[4] : undefined,
    });
  } catch (e) {
    Logger.log('Engine move invalid: ' + uciMove + ' — ' + e.toString());
    throw new Error('Engine returned invalid move: ' + uciMove);
  }
  if (!move) {
    Logger.log('Engine move rejected by chess.js: ' + uciMove);
    throw new Error('Engine returned illegal move: ' + uciMove);
  }
  const newFen = chess.fen();
  const san = move.san;
  Logger.log('Engine move validated: ' + san + ' | New FEN: ' + newFen);
  const engineColour = state.playerColour === 'white' ? 'black' : 'white';
  const movePrefix = engineColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';
  state.fen = newFen;
  state.moveHistory = safeTrim(
    (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + san,
    CONFIG.MAX_MOVEHIST_LEN
  );
  if (engineColour === 'black') state.moveNumber++;
  let gameOver = false;
  let gameResult = '';
  if (chess.isCheckmate()) {
    state.gameActive = false;
    gameOver = true;
    gameResult = engineColour + ' wins by checkmate';
  } else if (chess.isDraw()) {
    state.gameActive = false;
    gameOver = true;
    if (chess.isStalemate()) gameResult = 'Draw by stalemate';
    else if (chess.isThreefoldRepetition()) gameResult = 'Draw by threefold repetition';
    else gameResult = 'Draw';
  }
  saveGameState(state);
  return {
    move: san,
    fen: newFen,
    evaluation: engineResult.evaluation,
    gameOver: gameOver,
    result: gameResult,
  };
}
function getCommentary(playerMove, engineMove, state) {
  try {
    const systemPrompt = getCommentaryPrompt(state);
    const userMessage =
      `Current FEN: ${state.fen}\n` +
      `Move history: ${state.moveHistory || '(game start)'}\n` +
      `Player's move: ${playerMove}\n` +
      `Engine's response: ${engineMove}`;
    const responseText = callClaude(systemPrompt, userMessage);
    const cleaned = String(responseText || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return safeTrim(parsed.comment || '', CONFIG.MAX_COMMENT_LEN);
  } catch (e) {
    Logger.log('Commentary failed (non-fatal): ' + e.toString());
    return '';
  }
}
function processPlayerMove(moveStr) {
  const state = getGameState();
  if (!state.gameActive) return { error: 'No active game. Reply NEW to start one.' };
  moveStr = String(moveStr || '').trim();
  if (!moveStr) return { error: 'Empty move. Reply with a move like Nf3 or e4.' };
  if (moveStr.length > CONFIG.MAX_MOVE_LEN) return { error: 'Move too long. Use standard algebraic notation (e.g., Nf3).' };
  Logger.log('Processing move: ' + moveStr);
  Logger.log('Current FEN: ' + state.fen);
  Logger.log('Player colour: ' + state.playerColour);
  Logger.log('Move history: ' + state.moveHistory);
  try {
    const chess = new Chess(state.fen);
    const fenTurn = state.fen.split(' ')[1];
    const expectedTurn = state.playerColour === 'white' ? 'w' : 'b';
    if (fenTurn !== expectedTurn) {
      return { error: 'It\'s not your turn. Waiting for the engine\'s move.' };
    }
    let move;
    try {
      move = chess.move(moveStr);
    } catch (moveError) {
      const legalMoves = chess.moves();
      Logger.log('Illegal move attempted: ' + moveStr + '. Legal moves: ' + legalMoves.join(', '));
      if (/^[a-h][1-8]$/.test(moveStr)) {
        const pawnMoves = legalMoves.filter(m => m === moveStr || m.endsWith(moveStr));
        if (pawnMoves.length > 0) {
          return { error: 'Ambiguous pawn move. Please specify: ' + pawnMoves.join(' or ') };
        }
      }
      return { error: 'Illegal move. Legal moves include: ' + legalMoves.slice(0, 10).join(', ') + (legalMoves.length > 10 ? '...' : '') };
    }
    const nextFen = chess.fen();
    const stdMove = move.san;
    Logger.log('Move validated successfully: ' + stdMove);
    Logger.log('New FEN: ' + nextFen);
    const movePrefix = state.playerColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';
    state.fen = nextFen;
    state.moveHistory = safeTrim(
      (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + stdMove,
      CONFIG.MAX_MOVEHIST_LEN
    );
    if (state.playerColour === 'black') state.moveNumber++;
    saveGameState(state);
    return { success: true, move: stdMove, fen: nextFen };
  } catch (e) {
    Logger.log('Error processing move with chess.js: ' + e.toString());
    return { error: 'Failed to process move. Please check your notation and try again.' };
  }
}
// --- IMPROVED EMAIL SENDING ---
// Removes auto-archiving from sendGameEmail
function sendGameEmail(subjectPrefix, body) {
  const state = getGameState();
  const subject = buildSubject(subjectPrefix);
  if (state.threadId) {
    const thread = GmailApp.getThreadById(state.threadId);
    if (thread) {
      thread.reply(body);
      // Add label
      let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
      if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
      thread.addLabel(label);
      // Don't archive here - let checkForReplies handle it
      Logger.log('Sent reply to existing thread');
      return;
    }
  }
  // No thread - create new one
  GmailApp.sendEmail(getDestinationEmail(), subject, body);
  Utilities.sleep(2000);
  // Find the new thread
  const token = getOrCreateGameToken();
  const q = `from:me to:${getDestinationEmail()} subject:"[chess:${token}]" newer_than:1d`;
  let threads = GmailApp.search(q, 0, 10);
  if (threads.length === 0) {
    Utilities.sleep(2000);
    threads = GmailApp.search(q, 0, 10);
  }
  if (threads.length > 0) {
    const newest = threads.reduce((latest, current) =>
      current.getLastMessageDate() > latest.getLastMessageDate() ? current : latest,
      threads[0]
    );
    state.threadId = newest.getId();
    // Add label
    let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
    if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
    newest.addLabel(label);
    // Save the new thread ID
    saveGameState(state);
    // Don't archive new threads
    Logger.log('Created new thread: ' + state.threadId);
  }
}
function buildMoveEmail(engineResponse, commentary) {
  const state = getGameState();
  let body = `Engine plays: ${engineResponse.move}\n\n`;
  if (engineResponse.evaluation) {
    const eval_ = engineResponse.evaluation;
    if (eval_.type === 'cp') {
      const pawns = (eval_.value / 100).toFixed(1);
      body += `Evaluation: ${eval_.value > 0 ? '+' : ''}${pawns} pawns\n\n`;
    } else if (eval_.type === 'mate') {
      body += `Evaluation: Mate in ${eval_.value}\n\n`;
    }
  }
  if (commentary) {
    body += `${commentary}\n\n`;
  }
  body += `Move history: ${state.moveHistory}\n\n`;
  if (engineResponse.gameOver) {
    body += `Game over: ${engineResponse.result}\n\n`;
    body += `Reply NEW to start a new game.\n`;
  } else {
    body += `Reply with your move:\n`;
    body += `  • Pawn moves: just the square (e.g. e4, b3, d5)\n`;
    body += `  • Piece moves: piece + square (e.g. Nf3, Be5, Qd1)\n`;
    body += `  • Castling: O-O or O-O-O\n`;
    body += `Reply NEW to start a new game.\n`;
    body += `Reply RESIGN to resign.\n`;
    body += `Reply PAUSE to pause daily emails.\n`;
  }
  body += NOTATION_GUIDE;
  return safeTrim(body, 20000);
}
// --- IMPROVED REPLY PARSING ---
// More flexible parsing that handles various email formats
function extractMoveFromReply(messageBody) {
  if (!messageBody) return null;
  // Convert to string and handle different line endings
  const text = String(messageBody)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  // Extract the fresh content (before quotes/signatures)
  const lines = text.split('\n');
  const freshLines = [];
  let totalChars = 0;
  for (let i = 0; i < Math.min(lines.length, CONFIG.MAX_PARSE_LINES); i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Stop at common quote/signature markers
    if (trimmed.startsWith('>')) break;
    if (trimmed.startsWith('On ') && line.includes(' wrote:')) break;
    if (trimmed === '--') break;
    if (trimmed.match(/^-{3,}$/)) break;
    if (trimmed.match(/^_{3,}$/)) break;
    if (trimmed.match(/^\*{3,}$/)) break;
    if (trimmed.startsWith('From:')) break;
    if (trimmed.startsWith('Sent from')) break;
    freshLines.push(trimmed);
    totalChars += trimmed.length;
    if (totalChars > CONFIG.MAX_PARSE_LENGTH) break;
  }
  const freshText = freshLines.join(' ').trim();
  if (!freshText) return null;
  // Skip automated emails from the script itself
  const skipPhrases = [
    'Engine plays:', 'Your move:', 'New game!', 'You resigned.',
    'Game paused.', 'Game resumed!', 'It\'s your move!',
    'No active game.', 'Illegal move', 'Game Over', 'Checkmate',
    'Draw by', 'Stalemate'
  ];
  for (const phrase of skipPhrases) {
    if (freshText.startsWith(phrase)) return null;
  }
  // Check for commands (case insensitive, anywhere in fresh text)
  const upperText = freshText.toUpperCase();
  const firstWord = upperText.split(/\s+/)[0];
  // Exact match for first word
  if (firstWord === 'NEW') return { command: 'new' };
  if (firstWord === 'RESIGN') return { command: 'resign' };
  if (firstWord === 'PAUSE') return { command: 'pause' };
  if (firstWord === 'CONTINUE') return { command: 'continue' };
  // Also check if command appears clearly in the text
  if (upperText.includes('START NEW GAME')) return { command: 'new' };
  if (upperText.includes('I RESIGN')) return { command: 'resign' };
  // Look for chess moves - try multiple patterns
  const movePatterns = [
    // Standard algebraic notation
    /\b([KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/i,
    // Pawn moves
    /\b([a-h]x?[a-h]?[1-8](?:=[QRBN])?[+#]?)\b/i,
    // Castling
    /\b(O-O-O|O-O|0-0-0|0-0)\b/i,
    // Simple destination (like "e4" or "d5")
    /\b([a-h][1-8])\b/,
  ];
  // Try each pattern
  for (const pattern of movePatterns) {
    const matches = freshText.match(pattern);
    if (matches) {
      const move = matches[1].replace(/0/g, 'O'); // Convert zeros to O for castling
      Logger.log('Found move: ' + move + ' using pattern: ' + pattern);
      return { move: move };
    }
  }
  // If the entire message is short and looks like a move, accept it
  if (freshText.length <= 10) {
    // Remove all spaces and check if it looks like a move
    const compact = freshText.replace(/\s+/g, '');
    if (/^[KQRBNPa-h0-9xO\-\+=#]+$/i.test(compact)) {
      Logger.log('Accepting short text as move: ' + compact);
      return { move: compact };
    }
  }
  Logger.log('No move or command found in: ' + freshText.substring(0, 100));
  return null;
}
// --- IMPROVED POLL FOR REPLIES WITH SMART ARCHIVING ---
function checkForReplies() {
  return withScriptLock(() => {
    const state = getGameState();
    const thread = findGameThread();
    if (!thread) {
      Logger.log('No active game thread found');
      return;
    }
    // Smart archiving: Move to inbox while processing
    if (CONFIG.AUTO_ARCHIVE === 'smart') {
      thread.moveToInbox();
      Logger.log('Moved thread to inbox for processing');
    }
    const messages = thread.getMessages();
    const lastProcessedId = getLastProcessedMessageId();
    Logger.log(`Thread has ${messages.length} messages. Last processed: ${lastProcessedId}`);
    // Find where we left off
    let startIndex = 0;
    if (lastProcessedId) {
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].getId() === lastProcessedId) {
          startIndex = i + 1;
          break;
        }
      }
    }
    Logger.log(`Starting processing from message index ${startIndex}`);
    // Track if we processed anything
    let processedAny = false;
    let lastMessageId = lastProcessedId;
    // Process new messages
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      const msgId = msg.getId();
      Logger.log(`Processing message ${i}: From ${msg.getFrom()}`);
      // Skip messages not from the player
      if (!onlyMeGuard(msg)) {
        Logger.log('Skipping - not from authorized sender');
        lastMessageId = msgId;
        continue;
      }
      // Try to extract move or command
      const parsed = extractMoveFromReply(msg.getPlainBody());
      if (!parsed) {
        Logger.log('No move/command found in message');
        lastMessageId = msgId;
        continue;
      }
      // We found something to process
      processedAny = true;
      lastMessageId = msgId;
      // Save progress before processing (in case of errors)
      setLastProcessedMessageId(msgId);
      // Handle commands
      if (parsed.command === 'new') {
        Logger.log('Processing NEW command');
        startNewGameInternal_();
        return;
      }
      if (parsed.command === 'resign') {
        Logger.log('Processing RESIGN command');
        state.gameActive = false;
        saveGameState(state);
        sendGameEmail(
          '♟ Chess',
          'You resigned. Good game!\n\n' +
          'Move history: ' + state.moveHistory +
          '\n\nReply NEW to start a new game.'
        );
        archiveIfAppropriate(thread, 'game_over');
        return;
      }
      if (parsed.command === 'pause') {
        Logger.log('Processing PAUSE command');
        state.paused = true;
        saveGameState(state);
        sendGameEmail('♟ Chess', 'Game paused. Reply CONTINUE to resume.');
        archiveIfAppropriate(thread, 'paused');
        return;
      }
      if (parsed.command === 'continue') {
        Logger.log('Processing CONTINUE command');
        state.paused = false;
        saveGameState(state);
        sendGameEmail(
          '♟ Chess',
          'Game resumed!\n\n' +
          'Move history: ' + state.moveHistory +
          '\n\nReply with your move.'
        );
        // Don't archive - waiting for player move
        return;
      }
      // Check if game is paused
      if (state.paused) {
        sendGameEmail('♟ Chess', 'Game is paused. Reply CONTINUE to resume.');
        archiveIfAppropriate(thread, 'paused');
        return;
      }
      // Process move
      if (parsed.move) {
        Logger.log('Processing move: ' + parsed.move);
        const result = processPlayerMove(parsed.move);
        if (result.error) {
          Logger.log('Move error: ' + result.error);
          const cur = getGameState();
          sendGameEmail(
            '♟ Chess',
            result.error +
            '\n\nMove history: ' + cur.moveHistory +
            '\n\nReply with a valid move.'
          );
          // Don't archive on error - keep visible for correction
          return;
        }
        Logger.log('Player move accepted: ' + result.move);
        // Get engine response
        const engineResult = getEngineMove();
        if (engineResult) {
          const commentary = getCommentary(result.move, engineResult.move, getGameState());
          const emailBody = 'Your move: ' + result.move + '\n\n' + buildMoveEmail(engineResult, commentary);
          sendGameEmail('♟ Chess', emailBody);
          // Smart archive: Archive because we're now waiting for player
          archiveIfAppropriate(thread, 'waiting_for_player');
        }
        return;
      }
    }
    // Update last processed ID if we went through messages
    if (lastMessageId !== lastProcessedId) {
      setLastProcessedMessageId(lastMessageId);
    }
    // If we didn't process anything and using smart archive,
    // move back to archive since we're still waiting
    if (!processedAny && CONFIG.AUTO_ARCHIVE === 'smart') {
      thread.moveToArchive();
      Logger.log('No new moves found - moved thread back to archive');
    }
  });
}
// --- NEW GAME ---
// Internal version — no lock. Called from within locked contexts.
function startNewGameInternal_(difficulty, colour) {
  const diff = difficulty || CONFIG.DIFFICULTY;
  const col = colour || CONFIG.PLAYER_COLOUR;
  PropertiesService.getScriptProperties().deleteProperty('CHESS_GAME_TOKEN');
  const state = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: true,
    moveNumber: 1,
    difficulty: diff,
    playerColour: col,
    threadId: '',
    lastProcessedCount: 0,
    paused: false,
  };
  saveGameState(state);
  if (col === 'black') {
    const engineResult = getEngineMove();
    if (engineResult) {
      let body = `New game! You are black. Difficulty: ${diff}.\n\n`;
      body += buildMoveEmail(engineResult, '');
      body += NOTATION_GUIDE;
      sendGameEmail('♟ New Chess Game', body);
    }
  } else {
    let body = `New game! You are white. Difficulty: ${diff}.\n\n`;
    body += `Reply with your opening move (e.g. e4, d4, Nf3).\n`;
    body += NOTATION_GUIDE;
    sendGameEmail('♟ New Chess Game', body);
  }
}
// Public entry point — acquires lock.
function startNewGameViaEmail(difficulty, colour) {
  return withScriptLock(() => startNewGameInternal_(difficulty, colour));
}
// --- TRIGGERS ---
function setupTriggers() {
  preflight();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkForReplies')
    .timeBased()
    .everyMinutes(CONFIG.POLL_MINUTES)
    .create();
  Logger.log('Trigger set: reply check every ' + CONFIG.POLL_MINUTES + ' minutes.');
}
// --- MANUAL START ---
function startFirstGame() {
  preflight();
  startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);
}
// --- ONE-STEP SETUP ---
// Run this ONCE to set up everything and start your first game
function quickStart() {
  Logger.log('🚀 Starting Quick Setup...');
  Logger.log('1/4 Initializing GameState sheet...');
  initialiseSheet();
  Logger.log('2/4 Validating configuration...');
  preflight();
  Logger.log('3/4 Setting up triggers...');
  setupTriggers();
  Logger.log('4/4 Starting first game...');
  startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);
  Logger.log('✅ Setup complete! Check your inbox for the first chess email.');
  Logger.log('📧 The thread will be labeled "chess-game" and auto-archived after moves.');
  Logger.log('♟️  Reply with your move to play!');
}
// --- MIGRATION & DEBUG HELPERS ---
// Run this once to migrate from count-based to ID-based tracking
function migrateToMessageIdTracking() {
  const state = getGameState();
  const thread = findGameThread();
  if (!thread) {
    Logger.log('No thread to migrate');
    return;
  }
  const messages = thread.getMessages();
  const lastProcessedCount = state.lastProcessedCount || 0;
  if (lastProcessedCount > 0 && lastProcessedCount <= messages.length) {
    const lastMessage = messages[lastProcessedCount - 1];
    setLastProcessedMessageId(lastMessage.getId());
    Logger.log(`Migrated: Set last processed message ID from count ${lastProcessedCount}`);
  } else {
    Logger.log('No migration needed');
  }
}
// Check the current game state
function debugGameState() {
  const state = getGameState();
  const thread = findGameThread();
  const lastMsgId = getLastProcessedMessageId();
  Logger.log('=== GAME STATE DEBUG ===');
  Logger.log('Active: ' + state.gameActive);
  Logger.log('Paused: ' + state.paused);
  Logger.log('Thread ID: ' + state.threadId);
  Logger.log('Found thread: ' + (thread ? 'Yes' : 'No'));
  Logger.log('Message count: ' + (thread ? thread.getMessageCount() : 'N/A'));
  Logger.log('Last processed ID: ' + lastMsgId);
  Logger.log('Move history: ' + state.moveHistory);
  Logger.log('Current FEN: ' + state.fen);
  Logger.log('Archive mode: ' + CONFIG.AUTO_ARCHIVE);
}
// Manually check for replies
function manualCheckReplies() {
  Logger.log('=== MANUAL REPLY CHECK ===');
  checkForReplies();
}
// Reset tracking (use if things get stuck)
function resetMessageTracking() {
  PropertiesService.getScriptProperties().deleteProperty('CHESS_LAST_MESSAGE_ID');
  Logger.log('Reset message tracking - will reprocess all messages in thread');
}
// Test move extraction
function testMoveExtraction() {
  const testCases = [
    'e4',
    'Nf3',
    'O-O',
    '0-0-0',
    'Qxd5+',
    'e4\n\nSent from my iPhone',
    '> On date, person wrote:\n> previous message\n\ne4',
    'I\'ll play e4',
    'My move is Nf3',
    'NEW',
    'resign',
    'Here is my move: Bc4',
  ];
  Logger.log('=== MOVE EXTRACTION TESTS ===');
  for (const test of testCases) {
    const result = extractMoveFromReply(test);
    Logger.log(`"${test.substring(0, 30)}..." => ${JSON.stringify(result)}`);
  }
}