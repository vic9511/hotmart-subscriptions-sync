// supabase/functions/verify-subscription/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Content-Type': 'application/json',
	'Cache-Control': 'no-store',
};

function normalizeEmail(raw) {
	return (raw ?? '').toString().trim().toLowerCase();
}

async function adminGetUserIdByEmail(supabaseUrl, serviceRoleKey, email) {
	const url = `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`;
	const res = await fetch(url, {
		method: 'GET',
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
		},
	});
	if (!res.ok) return null;
	const data = await res.json();
	if (Array.isArray(data) && data.length > 0 && data[0]?.id) return data[0].id;
	if (Array.isArray(data?.users) && data.users[0]?.id) return data.users[0].id;
	if (data && typeof data === 'object' && 'id' in data) return data.id;
	return null;
}

Deno.serve(async req => {
	if (req.method === 'OPTIONS') {
		return new Response('ok', {
			headers: corsHeaders,
		});
	}
	if (req.method !== 'POST') {
		return new Response(
			JSON.stringify({
				error: 'Method not allowed',
			}),
			{
				status: 405,
				headers: corsHeaders,
			}
		);
	}
	try {
		let body;
		try {
			body = await req.json();
		} catch {
			return new Response(
				JSON.stringify({
					error: 'Invalid JSON body',
				}),
				{
					status: 400,
					headers: corsHeaders,
				}
			);
		}
		const rawEmail = normalizeEmail(body?.email);
		if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
			return new Response(
				JSON.stringify({
					error: 'Email is required and must be valid',
				}),
				{
					status: 400,
					headers: corsHeaders,
				}
			);
		}
		const supabaseUrl = Deno.env.get('SUPABASE_URL');
		const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
		if (!supabaseUrl || !serviceRoleKey) {
			return new Response(
				JSON.stringify({
					error: 'Server configuration error',
				}),
				{
					status: 500,
					headers: corsHeaders,
				}
			);
		}
		const supabase = createClient(supabaseUrl, serviceRoleKey, {
			auth: {
				persistSession: false,
				autoRefreshToken: false,
			},
		});
		// 1) Ask Postgres (single source of truth)
		const { data, error } = await supabase
			.rpc('subscription_access_by_email', {
				p_email: rawEmail,
			})
			.maybeSingle();
		if (error) {
			return new Response(
				JSON.stringify({
					hasActiveSubscription: false,
					error: 'Error checking subscription',
					details: error.message,
				}),
				{
					status: 500,
					headers: corsHeaders,
				}
			);
		}
		// 2) No subscription row found
		if (!data) {
			return new Response(
				JSON.stringify({
					hasActiveSubscription: false,
					message: 'No subscription record',
				}),
				{
					status: 200,
					headers: corsHeaders,
				}
			);
		}
		// 3) Autolink user_id if missing (best-effort)
		let userId = data.user_id ?? null;
		if (!userId) {
			userId = await adminGetUserIdByEmail(supabaseUrl, serviceRoleKey, rawEmail);
			if (userId && data.subscription_id) {
				const { error: linkErr } = await supabase
					.from('subscriptions')
					.update({
						user_id: userId,
					})
					.eq('id', data.subscription_id);
				if (linkErr) console.error('Failed to update subscription.user_id:', linkErr);
			}
		}
		// 4) Build response
		const result = {
			hasActiveSubscription: Boolean(data.has_access),
			plan: data.plan ?? null,
			status: data.status ?? null,
			date_next_charge: data.date_next_charge ?? null,
			cancel_pending: Boolean(data.cancel_pending),
			user_id: userId,
			message: data.has_access ? 'Active subscription found' : 'Inactive subscription',
		};
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: corsHeaders,
		});
	} catch (err) {
		const details = err instanceof Error ? err.message : String(err);
		return new Response(
			JSON.stringify({
				error: 'Internal server error',
				details,
				hasActiveSubscription: false,
			}),
			{
				status: 500,
				headers: corsHeaders,
			}
		);
	}
});
