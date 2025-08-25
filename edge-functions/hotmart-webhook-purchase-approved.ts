// Edge Function: hotmart-webhook-purchase-approved (matches new DB schema)
// - Upserts into 'subscriptions' (adds subscriber_code; no last_event* fields)
// - Inserts into 'subscription_events' with FK to the subscription row
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
// Map product/plan names to enum: BASIC | PRO | VIP
function determinePlan(productName, planName) {
	const name = (productName || planName || '').trim().toLowerCase();
	if (name.includes('vip')) return 'VIP';
	if (name.includes('pro')) return 'PRO';
	return 'BASIC';
}
// Accepts ms, seconds (epoch), or ISO string -> returns ISO or null
function toIsoDate(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') {
		const ms = value < 1e12 ? value * 1000 : value;
		const d = new Date(ms);
		return isNaN(d.getTime()) ? null : d.toISOString();
	}
	if (typeof value === 'string') {
		const d = new Date(value);
		return isNaN(d.getTime()) ? null : d.toISOString();
	}
	return null;
}
// Fallback: if date_next_charge is null, use same day next month (UTC-based)
function nextMonthSameDayIso(baseDate = new Date()) {
	const y = baseDate.getUTCFullYear();
	const m = baseDate.getUTCMonth();
	const d = baseDate.getUTCDate();
	const hh = baseDate.getUTCHours();
	const mm = baseDate.getUTCMinutes();
	const ss = baseDate.getUTCSeconds();
	const ms = baseDate.getUTCMilliseconds();
	return new Date(Date.UTC(y, m + 1, d, hh, mm, ss, ms)).toISOString();
}
serve(async req => {
	// CORS preflight
	if (req.method === 'OPTIONS') {
		console.log('[PURCHASE_APPROVED] CORS preflight (OPTIONS)');
		return new Response('ok', {
			headers: corsHeaders,
		});
	}
	// Only POST
	if (req.method !== 'POST') {
		console.warn(`[PURCHASE_APPROVED] Method not allowed: ${req.method}`);
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
		console.log('[PURCHASE_APPROVED] Parsing JSON body…');
		const webhook = await req.json();
		console.log('[PURCHASE_APPROVED] Webhook received:', JSON.stringify(webhook, null, 2));
		// Basic payload check
		if (!webhook?.data) {
			console.warn("[PURCHASE_APPROVED] Invalid payload: missing 'data'");
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
		// Endpoint is strictly for PURCHASE_APPROVED
		if (webhook?.event && webhook.event !== 'PURCHASE_APPROVED') {
			console.log(`[PURCHASE_APPROVED] Ignored different event: ${webhook.event}`);
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
			console.error('[PURCHASE_APPROVED] Missing Supabase env vars', {
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
			console.warn('[PURCHASE_APPROVED] Missing buyer email');
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
		const plan = determinePlan(data?.product?.name, data?.subscription?.plan?.name);
		const status = 'ACTIVE';
		const rawNextCharge = data?.purchase?.date_next_charge ?? null;
		const dateNextChargeIso = toIsoDate(rawNextCharge) ?? nextMonthSameDayIso(new Date());
		const subscriberCode = data?.subscription?.subscriber?.code ?? null;
		console.log('[PURCHASE_APPROVED] Parsed:', {
			email,
			plan,
			status,
			date_next_charge: dateNextChargeIso,
			subscriber_code: subscriberCode,
		});
		// Upsert into subscriptions and return the row id
		const upsertPayload = {
			buyer_email: email,
			subscriber_code: subscriberCode,
			plan,
			status,
			date_next_charge: dateNextChargeIso,
			cancel_pending: false,
		};
		const { data: subRow, error: upErr } = await supabase
			.from('subscriptions')
			.upsert(upsertPayload, {
				onConflict: 'buyer_email',
			})
			.select('id') // return the subscription id for FK
			.single();
		if (upErr) {
			console.error('[PURCHASE_APPROVED] Upsert error:', upErr);
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
		const eventType = webhook?.event ?? 'PURCHASE_APPROVED';
		const { error: evErr } = await supabase.from('subscription_events').insert({
			subscription_id: subRow.id,
			event_id: eventId,
			event_type: eventType,
			payload: data,
		});
		if (evErr) {
			console.error('[PURCHASE_APPROVED] Event insert error:', evErr);
			// Do not fail the whole request if logging fails
		}
		const resBody = {
			success: true,
			action: 'upserted',
			buyer_email: email,
			subscriber_code: subscriberCode,
			plan,
			status,
			date_next_charge: dateNextChargeIso,
		};
		console.log('[PURCHASE_APPROVED] Response 200:', resBody);
		return new Response(JSON.stringify(resBody), {
			status: 200,
			headers: corsHeaders,
		});
	} catch (error) {
		console.error('[PURCHASE_APPROVED] Unhandled error:', error);
		return new Response(
			JSON.stringify({
				error: 'Internal server error',
				details: String(error?.message ?? error),
			}),
			{
				status: 500,
				headers: corsHeaders,
			}
		);
	}
});
