export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, context } = req.body;

  if (!query || !context) {
    return res.status(400).json({ error: 'Missing query or context' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: 'You are a New Zealand job market analyst. Answer questions based only on the job listings provided. Be specific, cite numbers and examples, keep answers concise and useful.',
          },
          {
            role: 'user',
            content: `Job listings:\n\n${context}\n\nQuestion: ${query}`,
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'OpenAI error' });
    }

    return res.status(200).json({ answer: data.choices?.[0]?.message?.content || 'No answer generated.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}