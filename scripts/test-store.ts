import { readFile } from 'fs/promises';

async function main() {
	const job = {
		payload: {
			type: 'store',
			file_name: 'invoice.pdf',
			file_type: 'application/pdf',
			metadata: { type: 'invoice', department: 'finance' },
		},
	};
	const blob = new Blob([await readFile('scripts/data/invoice.pdf')], { type: 'application/pdf' });
	const formData = new FormData();
	formData.append('job', JSON.stringify(job));
	formData.append('file', blob, 'invoice.pdf');
	const response = await fetch('http://localhost:8787/', {
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
	console.log(JSON.stringify(data));
}

main().catch(console.error);
