/**
 * WebCut — safe expression evaluator for parameter scripting (#63).
 *
 * A tiny recursive-descent arithmetic interpreter — deliberately NOT `eval`,
 * so untrusted expression strings can never touch the DOM, globals, or
 * prototypes. Supports numeric literals, + - * / % ^, parentheses, a fixed set
 * of read-only variables, and a whitelist of pure math functions plus a
 * deterministic `wiggle(freq, amp)` for organic motion.
 *
 * Expressions evaluate to a single number and are sampled per frame in
 * `sampleAnimatable` (rotation / opacity today).
 */

export interface ExpressionContext {
  /** Playhead time in seconds (frame / fps). */
  readonly time: number;
  /** Playhead frame relative to the item's start. */
  readonly frame: number;
  /** Project frame rate. */
  readonly fps: number;
  /** The property's static "base" value, exposed as `value`. */
  readonly value: number;
}

// The render loop stamps the live fps here so `sampleAnimatable` (which only
// receives a frame) can build a full context without threading fps everywhere.
let ambientFps = 30;
export const setExpressionFps = (fps: number): void => {
  if (fps > 0) ambientFps = fps;
};
export const getExpressionFps = (): number => ambientFps;

// --- Deterministic value noise (for wiggle) ---------------------------------

const hash = (n: number): number => {
  // Cheap deterministic hash → [0,1).
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const smoothNoise = (x: number): number => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  const a = hash(i) * 2 - 1;
  const b = hash(i + 1) * 2 - 1;
  return a + (b - a) * u; // in [-1, 1]
};

// --- Tokenizer --------------------------------------------------------------

type Token =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "id"; readonly v: string }
  | { readonly t: "op"; readonly v: string };

const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i + 1;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      tokens.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}'`);
  }
  return tokens;
};

// --- Parser + evaluator (single pass, operator precedence) ------------------

const FUNCTIONS: Record<string, (args: number[], ctx: ExpressionContext) => number> = {
  sin: (a) => Math.sin(a[0]),
  cos: (a) => Math.cos(a[0]),
  tan: (a) => Math.tan(a[0]),
  abs: (a) => Math.abs(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  round: (a) => Math.round(a[0]),
  sqrt: (a) => Math.sqrt(a[0]),
  pow: (a) => Math.pow(a[0], a[1] ?? 2),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  clamp: (a) => Math.max(a[1] ?? 0, Math.min(a[2] ?? 1, a[0])),
  mod: (a) => a[0] % (a[1] ?? 1),
  // Deterministic per-frame noise: wiggle(freq, amp) — amp * smoothNoise(time*freq).
  wiggle: (a, ctx) => {
    const freq = a[0] ?? 2;
    const amp = a[1] ?? 10;
    return amp * smoothNoise(ctx.time * freq);
  },
  random: (a, ctx) => {
    // Frame-stable pseudo-random in [0, a[0]||1).
    const max = a[0] ?? 1;
    return hash(Math.floor(ctx.frame) + 0.5) * max;
  },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly ctx: ExpressionContext) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  parse(): number {
    const v = this.parseExpr();
    if (this.pos < this.tokens.length) throw new Error("Trailing tokens");
    return v;
  }

  // expr := term (('+' | '-') term)*
  private parseExpr(): number {
    let v = this.parseTerm();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.v === "+" || tok.v === "-")) {
        this.next();
        const r = this.parseTerm();
        v = tok.v === "+" ? v + r : v - r;
      } else break;
    }
    return v;
  }

  // term := power (('*' | '/' | '%') power)*
  private parseTerm(): number {
    let v = this.parsePower();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.v === "*" || tok.v === "/" || tok.v === "%")) {
        this.next();
        const r = this.parsePower();
        v = tok.v === "*" ? v * r : tok.v === "/" ? v / r : v % r;
      } else break;
    }
    return v;
  }

  // power := unary ('^' power)?  (right-assoc)
  private parsePower(): number {
    const base = this.parseUnary();
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === "^") {
      this.next();
      return Math.pow(base, this.parsePower());
    }
    return base;
  }

  private parseUnary(): number {
    const tok = this.peek();
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+")) {
      this.next();
      const v = this.parseUnary();
      return tok.v === "-" ? -v : v;
    }
    return this.parseAtom();
  }

  private parseAtom(): number {
    const tok = this.next();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.t === "num") return tok.v;
    if (tok.t === "op" && tok.v === "(") {
      const v = this.parseExpr();
      const close = this.next();
      if (!(close?.t === "op" && close.v === ")")) throw new Error("Missing ')'");
      return v;
    }
    if (tok.t === "id") {
      const name = tok.v;
      // Function call?
      if (this.peek()?.t === "op" && this.peek()!.v === "(") {
        this.next(); // consume '('
        const args: number[] = [];
        if (!(this.peek()?.t === "op" && this.peek()!.v === ")")) {
          args.push(this.parseExpr());
          while (this.peek()?.t === "op" && this.peek()!.v === ",") {
            this.next();
            args.push(this.parseExpr());
          }
        }
        const close = this.next();
        if (!(close?.t === "op" && close.v === ")")) throw new Error("Missing ')'");
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`Unknown function '${name}'`);
        return fn(args, this.ctx);
      }
      // Variable or constant.
      if (name === "time") return this.ctx.time;
      if (name === "frame") return this.ctx.frame;
      if (name === "fps") return this.ctx.fps;
      if (name === "value") return this.ctx.value;
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`Unknown identifier '${name}'`);
    }
    throw new Error("Unexpected token");
  }
}

/** Evaluate an expression string. Returns `ctx.value` on any parse/eval error. */
export const evaluateExpression = (expr: string, ctx: ExpressionContext): number => {
  try {
    const tokens = tokenize(expr);
    if (tokens.length === 0) return ctx.value;
    const result = new Parser(tokens, ctx).parse();
    return Number.isFinite(result) ? result : ctx.value;
  } catch {
    return ctx.value;
  }
};

/** Validate an expression, returning an error message or null when it's OK. */
export const validateExpression = (expr: string): string | null => {
  try {
    const tokens = tokenize(expr);
    if (tokens.length === 0) return "Empty expression";
    new Parser(tokens, { time: 0, frame: 0, fps: 30, value: 0 }).parse();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
