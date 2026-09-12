import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const exercise = url.searchParams.get('exercise')
    const chapter = url.searchParams.get('chapter')
    const subject = url.searchParams.get('subject')
    const difficulty = url.searchParams.get('difficulty')
    const id = url.searchParams.get('id')

    // Pagination — defaults match the frontend's page size; clamped since this
    // endpoint is public/unauthenticated.
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') ?? '30', 10) || 30))
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const SELECT_COLUMNS = `
        id, question_number, stem, stem_format, options, exercise_type, difficulty, source_page, has_diagram,
        chapters!inner(name, subjects!inner(name)),
        images(url, alt, role)
      `

    // Applies the same id/exercise/difficulty/chapter/subject filters regardless of
    // which query (page fetch or fallback count) they're being layered onto.
    function applyFilters(q: any) {
      if (id) q = q.eq('id', id)
      if (exercise) q = q.eq('exercise_type', exercise)
      if (difficulty) q = q.eq('difficulty', difficulty)
      if (chapter) q = q.eq('chapters.name', chapter)
      if (subject) q = q.eq('chapters.subjects.name', subject)
      return q
    }

    // Tie-break on id so .range() stays deterministic even when question_number
    // repeats across different papers/exercises (e.g. two papers both have a "Q1").
    let { data, error, count } = await applyFilters(
      supabase.from('questions').select(SELECT_COLUMNS, { count: 'exact' }),
    )
      .order('question_number')
      .order('id')
      .range(from, to)

    // PostgREST returns this when `from` lands beyond the actual row count for
    // this filter (e.g. a stale/hand-edited ?page=99) — treat it as a valid,
    // empty page (with the real total) instead of a hard error.
    if (error && /range not satisfiable/i.test(error.message)) {
      const { count: total, error: countErr } = await applyFilters(
        supabase.from('questions').select(SELECT_COLUMNS, { count: 'exact', head: true }),
      )
      if (countErr) {
        return new Response(JSON.stringify({ error: countErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ data: [], total: total ?? 0, page, page_size: pageSize }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Strip is_correct so the answer is never sent to the client up front
    const sanitized = (data ?? []).map((q: any) => ({
      id: q.id,
      question_number: q.question_number,
      stem: q.stem,
      stem_format: q.stem_format,
      options: (q.options ?? []).map((o: any) => ({ label: o.label, text: o.text })),
      exercise_type: q.exercise_type,
      difficulty: q.difficulty,
      source_page: q.source_page,
      has_diagram: q.has_diagram,
      chapter: q.chapters?.name,
      subject: q.chapters?.subjects?.name,
      images: q.images,
    }))

    return new Response(JSON.stringify({ data: sanitized, total: count ?? sanitized.length, page, page_size: pageSize }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
