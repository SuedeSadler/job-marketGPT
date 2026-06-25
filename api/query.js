export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, context } = req.body;

  if (!query || !context) {
    return res.status(400).json({ error: 'Missing query or context' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'You are a New Zealand job market analyst. Answer questions based only on the job listings provided. Be specific, cite numbers and examples, keep answers concise and useful.',
        messages: [{ role: 'user', content: `Job listings:\n\n${context}\n\nQuestion: ${query}` }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Claude API error' });
    }

    return res.status(200).json({ answer: data.content?.[0]?.text || 'No answer generated.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
