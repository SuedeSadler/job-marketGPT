export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const { query, context, listings } = await req.json();

  if (!query || !context) {
    return new Response(JSON.stringify({ error: 'Missing query or context' }), { status: 400 });
  }

  // Step 1: Expand the query into a richer version for better retrieval
  // (This happens before embedding — we already did the search, so now we use the expanded query for the answer prompt)
  const expandedQuery = expandQuery(query);

  const systemPrompt = `You are a knowledgeable Auckland job market analyst with access to real, live job listings scraped from Trade Me Jobs and Seek NZ.

RESPONSE FORMAT — always follow this structure:
1. Start with a 1-2 sentence direct answer to the question with specific numbers (e.g. "Based on 23 IT listings, the most requested skill is...")
2. Then give 2-4 bullet points of key insights with specific data
3. Then show 3-5 concrete job examples from the listings that illustrate your answer — format each as:
   **[Job Title]** at [Company] · [Location] · [Salary if available]
   → [One sentence explaining why this listing is relevant to the query]
4. End with one practical takeaway sentence

RULES:
- Always cite specific numbers ("14 out of 23 listings mention...")
- Always name real companies from the listings
- Never say "I don't have enough data" — work with what you have
- Never make up salaries or details not in the listings
- If salary isn't mentioned, say "salary not disclosed"
- Keep the total response under 300 words
- Use the job examples to make the answer tangible, not just abstract

You are answering this question about the Auckland job market: "${expandedQuery}"`;

  const userMessage = `Here are the most relevant job listings I found:\n\n${context}\n\nAnswer the question: "${query}"`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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

    if (!response.ok) {
      const err = await response.text();
      return new Response(JSON.stringify({ error: err }), { status: response.status });
    }

    // Stream the response back to the client
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); break; }

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

            for (const line of lines) {
              const data = line.slice(6);
              if (data === '[DONE]') { controller.close(); return; }
              try {
                const json = JSON.parse(data);
                const text = json.choices?.[0]?.delta?.content || '';
                if (text) controller.enqueue(encoder.encode(text));
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
        'Transfer-Encoding': 'chunked',
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
    return `What specific technical skills, qualifications, certifications, years of experience, and competencies are Auckland employers requesting in job listings? ${query}`;
  }
  if (q.includes('salary') || q.includes('pay') || q.includes('earn') || q.includes('wage') || q.includes('rate')) {
    return `What are the salary ranges, hourly rates, and compensation packages being offered in Auckland job listings? Include specific dollar amounts where available. ${query}`;
  }
  if (q.includes('remote') || q.includes('work from home') || q.includes('hybrid') || q.includes('wfh')) {
    return `Which Auckland employers and roles offer remote work, hybrid arrangements, or flexible working options? ${query}`;
  }
  if (q.includes('compan') || q.includes('employer') || q.includes('hiring') || q.includes('recruit')) {
    return `Which specific companies and organisations are actively hiring in Auckland right now, and what roles are they advertising? ${query}`;
  }
  if (q.includes('entry') || q.includes('junior') || q.includes('graduate') || q.includes('no experience')) {
    return `What entry-level, junior, or graduate roles are available in Auckland for people with limited experience? What qualifications do they require? ${query}`;
  }
  if (q.includes('it') || q.includes('tech') || q.includes('software') || q.includes('developer') || q.includes('engineer')) {
    return `What technology, software development, and IT roles are available in Auckland? What programming languages, frameworks, and tools are employers requesting? ${query}`;
  }
  if (q.includes('health') || q.includes('nurs') || q.includes('medical') || q.includes('care')) {
    return `What healthcare, nursing, and medical roles are available in Auckland? What qualifications and registrations are required? ${query}`;
  }

  return `In the context of current Auckland job listings from Trade Me and Seek NZ: ${query}`;
}