import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

function secretMatches(provided: string | null): boolean {
  const expected = Deno.env.get('ADMIN_SECRET') ?? ''
  if (!expected || !provided) return false
  const a = new TextEncoder().encode(provided)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

// RLS-bypassing client — same fallback as admin-mutate.
function adminClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!key) {
    try { key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? '' } catch { /* ignore */ }
  }
  return { supabase: createClient(url, key), keyPresent: !!key }
}

// Swap to 'claude-opus-5' for messier scans (roughly 2x cost).
const MODEL = 'claude-sonnet-5'

const QUESTION_TOOL = {
  name: 'emit_questions',
  description: 'Return every multiple-choice question visible on the supplied page images.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'question_number', 'stem', 'options', 'correct_label', 'answer_from',
            'has_diagram', 'diagram_bbox', 'difficulty', 'source_page',
          ],
          properties: {
            question_number: { type: 'integer' },
            stem: { type: 'string', description: 'Full question text; math as inline LaTeX between $...$; do NOT include the option list.' },
            options: {
              type: 'array',
              description: 'The printed choices, in order.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'text'],
                properties: { label: { type: 'string' }, text: { type: 'string' } },
              },
            },
            correct_label: { type: ['string', 'null'], description: 'the correct option a/b/c/d — from a printed key if visible, otherwise your own worked-out answer; null only if the question is unanswerable as shown' },
            answer_from: { type: 'string', enum: ['printed_key', 'solved'], description: '"printed_key" if correct_label came from an answer key visible in these images; "solved" if you worked it out yourself' },
            has_diagram: { type: 'boolean' },
            diagram_bbox: {
              type: ['array', 'null'],
              description: '[x, y, w, h] as page fractions (0-1) tightly enclosing the figure, else null',
              items: { type: 'number' },
            },
            difficulty: { type: ['string', 'null'], description: 'easy | medium | hard | null' },
            chapter: { type: ['string', 'null'], description: 'the single best-fit chapter for this question, copied EXACTLY from the chapter list in the prompt; null if none clearly fits' },
            source_page: { type: 'integer', description: 'the page number (from the list given in the prompt) where the question number is printed' },
          },
        },
      },
    },
  },
}

async function extract(pages: string[], pageNumbers: number[], chapterNames: string[] = []) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return { error: "ANTHROPIC_API_KEY is not set in this project's Edge Function secrets. Add it in Supabase → Project Settings → Edge Functions → Secrets, then retry.", status: 400 }
  }

  const content: unknown[] = []
  for (const p of pages) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(p ?? '')
    if (!m) return { error: 'each page must be a base64 image data URL', status: 400 }
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
  }
  const chapterBlock = chapterNames.length
    ? `\n\nAssign each question to one chapter. Choose the single best fit from this list and copy its name EXACTLY; use null if none clearly fits:\n${chapterNames.map((n) => `- ${n}`).join('\n')}`
    : '\n\nThere is no chapter list; set chapter to null for every question.'

  content.push({
    type: 'text',
    text:
`These images are consecutive pages of a scanned physics multiple-choice question paper. Page numbers, in order: ${pageNumbers.join(', ')}.

Extract EVERY complete multiple-choice question. For each:
- question_number: the printed number.
- stem: the full question text. Write ALL mathematics as inline LaTeX between $ ... $. Do not include the options in the stem.
- options: the printed choices, in order, labels lowercased to a, b, c, d.
- correct_label: the correct option. If an answer key is printed on THESE pages, use it. Otherwise solve the question yourself and give your best answer. Use null only when the question genuinely cannot be answered from what is shown.
- answer_from: "printed_key" when you copied the answer from a visible key, "solved" when you worked it out.
- has_diagram: true if the question depends on a figure / graph / circuit / diagram.
- diagram_bbox: when has_diagram, [x, y, w, h] as fractions of the page (0 to 1) tightly enclosing that figure; otherwise null.
- difficulty: your judgement — "easy", "medium", or "hard", or null.
- source_page: the page number (from the list above) on which the question number is printed.${chapterBlock}

Ignore chapter/section headings, instructions, and worked solutions. Skip any question that is cut off and not fully visible on these pages. Call emit_questions exactly once with the full list.`,
  })

  // Account-scoped keys need the workspace spelled out; workspace-scoped keys ignore it.
  const workspaceId = Deno.env.get('ANTHROPIC_WORKSPACE_ID')?.trim()
  const anthropicHeaders: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (workspaceId) anthropicHeaders['anthropic-workspace-id'] = workspaceId

  let resp: Response
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        tools: [QUESTION_TOOL],
        tool_choice: { type: 'tool', name: 'emit_questions' },
        messages: [{ role: 'user', content }],
      }),
    })
  } catch (err) {
    return { error: `Could not reach the Anthropic API: ${String(err)}`, status: 502 }
  }

  const rawText = await resp.text()
  if (!resp.ok) return { error: `Anthropic API ${resp.status}: ${rawText.slice(0, 600)}`, status: 502 }

  let data: any
  try { data = JSON.parse(rawText) } catch { return { error: 'Anthropic returned a non-JSON response', status: 502 } }
  if (data.stop_reason === 'refusal') return { error: 'The model declined to process one of these pages.', status: 502 }

  const block = (data.content || []).find((b: any) => b.type === 'tool_use' && b.name === 'emit_questions')
  if (!block) return { error: 'The model did not return structured questions.', status: 502 }

  return { questions: block.input?.questions ?? [], usage: data.usage }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  if (!secretMatches(req.headers.get('x-admin-secret'))) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  const { action } = body ?? {}

  try {
    if (action === 'list_targets') {
      const { supabase, keyPresent } = adminClient()
      if (!keyPresent) return json({ error: 'server is missing a privileged key' }, 500)
      const { data: chapters, error: cErr } = await supabase
        .from('chapters').select('id, name, subjects(name)').order('order')
      if (cErr) return json({ error: cErr.message }, 500)
      const { data: rows } = await supabase.from('questions').select('exercise_type, source_module')
      const uniq = (xs: any[]) => [...new Set(xs.filter(Boolean))]
      return json({
        chapters: (chapters ?? []).map((c: any) => ({ id: c.id, name: c.name, subject: c.subjects?.name })),
        exercise_types: uniq((rows ?? []).map((r: any) => r.exercise_type)),
        source_modules: uniq((rows ?? []).map((r: any) => r.source_module)),
      })
    }

    if (action === 'extract') {
      const pages: string[] = Array.isArray(body.pages) ? body.pages : []
      const pageNumbers: number[] = Array.isArray(body.page_numbers) ? body.page_numbers : pages.map((_, i) => i + 1)
      const chapterNames: string[] = Array.isArray(body.chapters)
        ? body.chapters.map((c: any) => String(c?.name ?? '').trim()).filter(Boolean)
        : []
      if (!pages.length || pages.length > 6) return json({ error: 'send 1–6 page images per call' }, 400)
      const res = await extract(pages, pageNumbers, chapterNames)
      if ((res as any).error) return json({ error: (res as any).error }, (res as any).status ?? 502)
      console.log(JSON.stringify({ fn: 'import-pdf/extract', pages: pages.length, got: (res as any).questions.length, usage: (res as any).usage }))
      return json({ questions: (res as any).questions })
    }

    if (action === 'commit') {
      const { supabase, keyPresent } = adminClient()
      if (!keyPresent) return json({ error: 'server is missing a privileged key' }, 500)

      const PAPER_TYPES = ['JEE', 'NEET', 'BITS', 'BOARDS', 'Other']
      const paper_type = PAPER_TYPES.includes(body.paper_type) ? body.paper_type : null
      const source_module = typeof body.source_module === 'string' && body.source_module.trim()
        ? body.source_module.trim() : null
      const questions: any[] = Array.isArray(body.questions) ? body.questions : []
      if (!paper_type) return json({ error: 'paper_type must be one of ' + PAPER_TYPES.join(', ') }, 400)
      if (!questions.length) return json({ error: 'no questions to import' }, 400)
      if (questions.some((q: any) => typeof q.chapter_id !== 'string' || !q.chapter_id)) {
        return json({ error: 'every question needs a chapter_id' }, 400)
      }

      // Dedupe within the same source paper (by file name): skip question numbers already imported from it.
      const taken = new Set<number>()
      if (source_module) {
        const { data: existing, error: exErr } = await supabase
          .from('questions').select('question_number').eq('source_module', source_module)
        if (exErr) return json({ error: exErr.message }, 500)
        for (const r of existing ?? []) taken.add(r.question_number)
      }

      const rows: any[] = []
      const skipped: number[] = []
      for (const q of questions) {
        const num = Number(q.question_number)
        if (!Number.isFinite(num)) continue
        if (taken.has(num)) { skipped.push(num); continue }
        const correct = typeof q.correct_label === 'string' ? q.correct_label.toLowerCase() : null
        const opts = Array.isArray(q.options) ? q.options : []
        rows.push({
          chapter_id: q.chapter_id,
          question_number: num,
          stem: String(q.stem ?? ''),
          stem_format: 'latex-markdown',
          options: opts.map((o: any) => ({
            label: String(o.label ?? '').toLowerCase(),
            text: String(o.text ?? ''),
            is_correct: String(o.label ?? '').toLowerCase() === correct,
          })),
          correct_label: correct,
          exercise_type: null,
          paper_type,
          difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : null,
          source_module,
          source_page: Number.isFinite(Number(q.source_page)) ? Number(q.source_page) : null,
          has_diagram: !!q.has_diagram,
        })
      }

      if (!rows.length) return json({ inserted: 0, skipped, ids: [] })
      const { data, error } = await supabase.from('questions').insert(rows).select('id, question_number')
      if (error) return json({ error: error.message }, 500)
      console.log(JSON.stringify({ fn: 'import-pdf/commit', inserted: data.length, skipped: skipped.length }))
      return json({ inserted: data.length, skipped, ids: data })
    }

    return json({ error: `Unknown action "${action}"` }, 400)
  } catch (err) {
    console.error(JSON.stringify({ fn: 'import-pdf', action, error: String(err) }))
    return json({ error: String(err) }, 500)
  }
})
