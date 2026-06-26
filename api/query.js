export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const { query, context } = await req.json();

  if (!query || !context) {
    return new Response(JSON.stringify({ error: 'Missing query or context' }), { status: 400 });
  }

  const expandedQuery = expandQuery(query);

  const systemPrompt = `You are a knowledgeable Auckland job market analyst. You have access to a dataset of over 4,000 live Auckland job listings scraped from Trade Me Jobs and Seek NZ. The listings provided to you are the most semantically relevant from that full dataset for this specific question.

RESPONSE FORMAT — always follow this structure exactly:
1. Start with a 1-2 sentence direct answer with specific numbers. Reference the full dataset size, e.g. "Across Auckland's IT job market, cloud computing is the most requested skill, appearing in 14 of the top listings analysed."
2. Then 2-4 bullet points of key insights with specific data. Use "• " to start each bullet.
3. Then show 3-5 concrete job examples from the listings. Format each one exactly like this:
**[Job Title]** at [Company] · [Location] · [Salary or "salary not disclosed"]
→ [One sentence explaining why this example is relevant]
4. End with one practical takeaway sentence starting with "Takeaway:"

RULES:
- Always cite specific numbers
- Always name real companies from the listings provided
- Never make up salaries — if not in the listing, say "salary not disclosed"
- Keep total response under 350 words
- Only reference the listings provided to you`;

  const userMessage = `Here are the ${context.split('---').length} most relevant Auckland job listings:\n\n${context}\n\nAnswer this question: "${expandedQuery}"`;

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      return new Response(JSON.stringify({ error: err }), { status: openaiRes.status });
    }

    // Parse SSE and stream only the text tokens
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = openaiRes.body.getReader();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); break; }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line in buffer

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const data = trimmed.slice(6);
              if (data === '[DONE]') { controller.close(); return; }
              try {
                const json = JSON.parse(data);
                const token = json.choices?.[0]?.delta?.content;
                if (token) controller.enqueue(encoder.encode(token));
              } catch {}
            }
          }
        } catch (err) {
          controller.error(err);
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

function expandQuery(query) {
  const q = query.toLowerCase();
  if (q.includes('skill') || q.includes('require') || q.includes('qualif')) {
    return `What specific technical skills, qualifications, certifications, and experience are Auckland employers requesting? ${query}`;
  }
  if (q.includes('salary') || q.includes('pay') || q.includes('earn') || q.includes('wage') || q.includes('rate')) {
    return `What are the salary ranges and compensation packages being offered in Auckland job listings? Include specific dollar amounts where available. ${query}`;
  }
  if (q.includes('remote') || q.includes('hybrid') || q.includes('wfh') || q.includes('work from home')) {
    return `Which Auckland employers and roles offer remote work, hybrid, or flexible working arrangements? ${query}`;
  }
  if (q.includes('compan') || q.includes('employer') || q.includes('hiring') || q.includes('recruit')) {
    return `Which specific companies are actively hiring in Auckland right now and what roles are they advertising? ${query}`;
  }
  if (q.includes('entry') || q.includes('junior') || q.includes('graduate') || q.includes('no experience')) {
    return `What entry-level, junior, or graduate roles are available in Auckland? What qualifications do they require? ${query}`;
  }
  if (q.includes('it') || q.includes('tech') || q.includes('software') || q.includes('developer')) {
    return `What technology and IT roles are available in Auckland? What programming languages, frameworks, and tools are employers requesting? ${query}`;
  }
  if (q.includes('health') || q.includes('nurs') || q.includes('medical')) {
    return `What healthcare and nursing roles are available in Auckland? What qualifications and registrations are required? ${query}`;
  }
  return `In the context of current Auckland job listings: ${query}`;
}