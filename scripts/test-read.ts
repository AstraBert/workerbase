async function read() {
	const file_key = process.argv[2];
	if (!file_key) {
		console.error('Usage: tsx retrieve.ts <file_key>');
		process.exit(1);
	}
	const job = {
		payload: {
			type: 'read',
			file_key,
			offset: 10,
			max_chars: 1000,
		},
	};
	const formData = new FormData();
	formData.append('job', JSON.stringify(job));
	const response = await fetch(process.env.WORKER_URL ?? 'http://localhost:8787/', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.INTERNAL_API_KEY!}`,
		},
		body: formData,
	});
	if (!response.ok) {
		console.error(`Response returned with status ${response.status} (${await response.text()})`);
		return;
	}
	const data = await response.json();
	console.log(JSON.stringify(data, undefined, 2));
}

read().catch(console.error);
