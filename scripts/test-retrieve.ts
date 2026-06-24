async function retrieve() {
	const file_key = process.argv[2];
	const job = {
		payload: {
			type: 'retrieve',
			file_key: file_key != '' ? file_key : undefined,
			query: 'Heavy cream',
			top_k: 3,
			filters: [{ field: 'type', operator: 'eq', value: 'invoice' }],
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

retrieve().catch(console.error);
