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

// Length-independent-ish comparison so a wrong secret doesn't leak length via timing.
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

// A Postgres client that bypasses RLS. Prefer the classic service-role key; fall
// back to this project's newer secret key bundle. Every table here has RLS on with
// read-only public policies, so an unprivileged write silently matches 0 rows.
function adminClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  let source = 'SUPABASE_SERVICE_ROLE_KEY'
  if (!key) {
    try {
      key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? ''
      source = 'SUPABASE_SECRET_KEYS.default'
    } catch {
      /* ignore malformed bundle */
    }
  }
  return { supabase: createClient(url, key), keyPresent: !!key, source }
}

// The full (admin-only) shape of a question, including the answer.
async function loadQuestion(supabase: any, questionId: string) {
  const { data, error } = await supabase
    .from('questions')
    .select(`
      id, chapter_id, question_number, stem, stem_format, options, correct_label,
      explanation, exercise_type, difficulty, source_module, source_page, tags, has_diagram,
      chapters!inner(name, subjects!inner(name)),
      images(id, url, alt, role)
    `)
    .eq('id', questionId)
    .single()

  if (error || !data) return { error: error?.message ?? 'Question not found' }

  return {
    question: {
      id: data.id,
      question_number: data.question_number,
      stem: data.stem,
      stem_format: data.stem_format,
      options: data.options ?? [],
      correct_label: data.correct_label,
      explanation: data.explanation,
      exercise_type: data.exercise_type,
      difficulty: data.difficulty,
      source_module: data.source_module,
      source_page: data.source_page,
      tags: data.tags,
      has_diagram: data.has_diagram,
      chapter: data.chapters?.name,
      subject: data.chapters?.subjects?.name,
      images: data.images ?? [],
    },
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  if (!secretMatches(req.headers.get('x-admin-secret'))) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { action, question_id } = body ?? {}
  if (!action) return json({ error: 'action is required' }, 400)
  if (!question_id) return json({ error: 'question_id is required' }, 400)

  const { supabase, keyPresent, source } = adminClient()
  if (!keyPresent) {
    console.error(JSON.stringify({ action, question_id, error: 'no privileged key in env' }))
    return json({ error: 'server is missing a privileged key' }, 500)
  }

  let rowsAffected: number | null = null

  try {
    switch (action) {
      case 'get_question': {
        const res = await loadQuestion(supabase, question_id)
        console.log(JSON.stringify({ action, question_id, keySource: source }))
        return res.error ? json({ error: res.error }, 404) : json(res.question)
      }

      case 'update_stem': {
        const stem = typeof body.stem === 'string' ? body.stem : null
        if (stem === null || stem.trim() === '') return json({ error: 'stem is required' }, 400)
        const { data, error } = await supabase
          .from('questions').update({ stem }).eq('id', question_id).select('id')
        if (error) return json({ error: error.message }, 500)
        rowsAffected = data?.length ?? 0
        if (!rowsAffected) return json({ error: 'update matched no rows (RLS or bad question_id)' }, 409)
        break
      }

      case 'update_option': {
        const label = typeof body.label === 'string' ? body.label : null
        const text = typeof body.text === 'string' ? body.text : null
        if (!label || text === null) return json({ error: 'label and text are required' }, 400)

        const { data: row, error: readErr } = await supabase
          .from('questions').select('options').eq('id', question_id).single()
        if (readErr || !row) return json({ error: readErr?.message ?? 'Question not found' }, 404)

        const options = (row.options ?? []) as Array<Record<string, unknown>>
        const idx = options.findIndex((o) => o.label === label)
        if (idx === -1) return json({ error: `No option with label "${label}"` }, 400)
        options[idx] = { ...options[idx], text }

        const { data, error } = await supabase
          .from('questions').update({ options }).eq('id', question_id).select('id')
        if (error) return json({ error: error.message }, 500)
        rowsAffected = data?.length ?? 0
        if (!rowsAffected) return json({ error: 'update matched no rows (RLS or bad question_id)' }, 409)
        break
      }

      case 'update_correct': {
        const correct_label = typeof body.correct_label === 'string' ? body.correct_label : null
        if (!correct_label) return json({ error: 'correct_label is required' }, 400)

        const { data: row, error: readErr } = await supabase
          .from('questions').select('options').eq('id', question_id).single()
        if (readErr || !row) return json({ error: readErr?.message ?? 'Question not found' }, 404)

        const options = (row.options ?? []) as Array<Record<string, unknown>>
        if (!options.some((o) => o.label === correct_label)) {
          return json({ error: `No option with label "${correct_label}"` }, 400)
        }
        const relabelled = options.map((o) => ({ ...o, is_correct: o.label === correct_label }))

        const { data, error } = await supabase
          .from('questions')
          .update({ options: relabelled, correct_label })
          .eq('id', question_id)
          .select('id')
        if (error) return json({ error: error.message }, 500)
        rowsAffected = data?.length ?? 0
        if (!rowsAffected) return json({ error: 'update matched no rows (RLS or bad question_id)' }, 409)
        break
      }

      case 'update_difficulty': {
        const difficulty = typeof body.difficulty === 'string' ? body.difficulty.toLowerCase() : null
        if (!difficulty || !['easy', 'medium', 'hard'].includes(difficulty)) {
          return json({ error: 'difficulty must be easy|medium|hard' }, 400)
        }
        const { data, error } = await supabase
          .from('questions').update({ difficulty }).eq('id', question_id).select('id')
        if (error) return json({ error: error.message }, 500)
        rowsAffected = data?.length ?? 0
        if (!rowsAffected) return json({ error: 'update matched no rows (RLS or bad question_id)' }, 409)
        break
      }

      case 'delete_diagram': {
        const { data, error } = await supabase
          .from('images').delete().eq('question_id', question_id).select('id')
        if (error) return json({ error: error.message }, 500)
        rowsAffected = data?.length ?? 0
        const { error: flagErr } = await supabase
          .from('questions').update({ has_diagram: false }).eq('id', question_id).select('id')
        if (flagErr) return json({ error: flagErr.message }, 500)
        break
      }

      case 'replace_diagram': {
        const svg = typeof body.svg_data_uri === 'string' ? body.svg_data_uri : null
        const alt = typeof body.alt === 'string' ? body.alt : null
        if (!svg || !svg.startsWith('data:image/svg+xml')) {
          return json({ error: 'svg_data_uri must be a data:image/svg+xml URI' }, 400)
        }

        // Find this question's existing diagram row (if any) and update it; otherwise insert.
        const { data: existing, error: findErr } = await supabase
          .from('images').select('id').eq('question_id', question_id).order('id').limit(1)
        if (findErr) return json({ error: findErr.message }, 500)

        if (existing && existing.length > 0) {
          const patch: Record<string, unknown> = { url: svg }
          if (alt !== null) patch.alt = alt
          const { data, error } = await supabase
            .from('images').update(patch).eq('id', existing[0].id).select('id')
          if (error) return json({ error: error.message }, 500)
          rowsAffected = data?.length ?? 0
          if (!rowsAffected) return json({ error: 'diagram update matched no rows (RLS)' }, 409)
        } else {
          const { data, error: insErr } = await supabase
            .from('images')
            .insert({ question_id, url: svg, alt: alt ?? 'Question diagram', role: 'inline_stem' })
            .select('id')
          if (insErr) return json({ error: insErr.message }, 500)
          rowsAffected = data?.length ?? 0
          if (!rowsAffected) return json({ error: 'diagram insert matched no rows (RLS)' }, 409)
          const { error: flagErr } = await supabase
            .from('questions').update({ has_diagram: true }).eq('id', question_id).select('id')
          if (flagErr) return json({ error: flagErr.message }, 500)
        }
        break
      }

      default:
        return json({ error: `Unknown action "${action}"` }, 400)
    }

    console.log(JSON.stringify({ action, question_id, keySource: source, rowsAffected }))

    // For every mutating action, return the fresh authoritative question.
    const res = await loadQuestion(supabase, question_id)
    return res.error ? json({ error: res.error }, 404) : json(res.question)
  } catch (err) {
    console.error(JSON.stringify({ action, question_id, error: String(err) }))
    return json({ error: String(err) }, 500)
  }
})
