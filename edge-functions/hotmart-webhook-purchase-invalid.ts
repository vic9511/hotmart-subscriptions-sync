// Edge Function: hotmart-webhook-purchase-invalid (matches new DB schema)
// - Supports PURCHASE_PROTEST, PURCHASE_CHARGEBACK, PURCHASE_DELAYED
// - Sets subscription status to 'INACTIVE' based on buyer.email
// - Logs the webhook into 'subscription_events' with correct event_type
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Content-Type': 'application/json',
	'Cache-Control': 'no-store',
	'Access-Control-Max-Age': '86400',
};
function normalizeEmail(raw) {
	return (raw ?? '').toString().trim().toLowerCase();
}
serve(async req => {
	// CORS preflight
	if (req.method === 'OPTIONS') {
		console.log('[WEBHOOK] CORS preflight (OPTIONS)');
		return new Response('ok', {
			headers: corsHeaders,
		});
	}
	// Only POST
	if (req.method !== 'POST') {
		console.warn('[WEBHOOK] Method not allowed:', req.method);
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
		// Parse body first so we can derive the event label for all logs
		const webhook = await req.json();
		const allowed = new Set(['PURCHASE_PROTEST', 'PURCHASE_CHARGEBACK', 'PURCHASE_DELAYED']);
		const eventType = allowed.has(webhook?.event)
			? webhook.event
			: (webhook?.event ?? 'PURCHASE_PROTEST'); // default behavior when event is missing
		const label = `[${eventType}]`;
		const log = (...a) => console.log(label, ...a);
		const warn = (...a) => console.warn(label, ...a);
		const error = (...a) => console.error(label, ...a);
		log('Webhook received:', JSON.stringify(webhook, null, 2));
		// Basic payload check
		if (!webhook?.data) {
			warn("Invalid payload: missing 'data'");
			return new Response(
				JSON.stringify({
					error: 'Invalid payload: missing data',
				}),
				{
					status: 400,
					headers: corsHeaders,
				}
			);
		}
		// Accept only PURCHASE_PROTEST, PURCHASE_CHARGEBACK or PURCHASE_DELAYED (ignore others)
		if (webhook?.event && !allowed.has(webhook.event)) {
			log(`Ignored different event: ${webhook.event}`);
			return new Response(
				JSON.stringify({
					message: 'Ignored: wrong event for this endpoint',
				}),
				{
					status: 200,
					headers: corsHeaders,
				}
			);
		}
		// Env
		const supabaseUrl = Deno.env.get('SUPABASE_URL');
		const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
		if (!supabaseUrl || !supabaseServiceKey) {
			error('Missing Supabase env vars', {
				hasUrl: !!supabaseUrl,
				hasServiceKey: !!supabaseServiceKey,
			});
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
		const supabase = createClient(supabaseUrl, supabaseServiceKey, {
			auth: {
				persistSession: false,
				autoRefreshToken: false,
			},
		});
		// Extract core info
		const data = webhook.data;
		const email = normalizeEmail(data?.buyer?.email);
		if (!email) {
			warn('Missing buyer email');
			return new Response(
				JSON.stringify({
					error: 'Email is required',
				}),
				{
					status: 400,
					headers: corsHeaders,
				}
			);
		}
		// Set subscription to INACTIVE (update if exists, insert if not)
		const upsertPayload = {
			buyer_email: email,
			status: 'INACTIVE',
			cancel_pending: false,
		};
		const { data: subRow, error: upErr } = await supabase
			.from('subscriptions')
			.upsert(upsertPayload, {
				onConflict: 'buyer_email',
			})
			.select('id')
			.single();
		if (upErr) {
			error('Upsert error:', upErr);
			return new Response(
				JSON.stringify({
					error: 'Upsert failed',
					details: upErr.message,
				}),
				{
					status: 500,
					headers: corsHeaders,
				}
			);
		}
		// Insert event row linked to the subscription
		const eventId = webhook?.id ?? null;
		const { error: evErr } = await supabase.from('subscription_events').insert({
			subscription_id: subRow.id,
			event_id: eventId,
			event_type: eventType,
			payload: data,
		});
		if (evErr) {
			error('Event insert error:', evErr);
			// Do not fail the whole request if logging fails
		}
		const resBody = {
			success: true,
			action: 'set_inactive',
			buyer_email: email,
			event_type: eventType,
			status: 'INACTIVE',
		};
		log('Response 200:', resBody);
		return new Response(JSON.stringify(resBody), {
			status: 200,
			headers: corsHeaders,
		});
	} catch (e) {
		console.error(
			'[PURCHASE_PROTEST/PURCHASE_CHARGEBACK/PURCHASE_DELAYED] Unhandled error:',
			e
		);
		return new Response(
			JSON.stringify({
				error: 'Internal server error',
				details: String(e?.message ?? e),
			}),
			{
				status: 500,
				headers: corsHeaders,
			}
		);
	}
});
