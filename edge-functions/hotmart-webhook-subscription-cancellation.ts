// Edge Function: hotmart-webhook-subscription-cancellation (matches new DB schema)
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
function toIsoDate(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') {
		const ms = value < 1e12 ? value * 1000 : value; // seconds -> ms
		const d = new Date(ms);
		return isNaN(d.getTime()) ? null : d.toISOString();
	}
	if (typeof value === 'string') {
		const d = new Date(value);
		return isNaN(d.getTime()) ? null : d.toISOString();
	}
	return null;
}
serve(async req => {
	// CORS preflight
	if (req.method === 'OPTIONS') {
		console.log('[SUBSCRIPTION_CANCELLATION] CORS preflight (OPTIONS)');
		return new Response('ok', {
			headers: corsHeaders,
		});
	}
	// Only POST
	if (req.method !== 'POST') {
		console.warn('[SUBSCRIPTION_CANCELLATION] Method not allowed:', req.method);
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
		// Parse body to get event label for logs
		const webhook = await req.json();
		const eventType = webhook?.event ?? 'SUBSCRIPTION_CANCELLATION';
		const label = `[${eventType}]`;
		const log = (...a) => console.log(label, ...a);
		const warn = (...a) => console.warn(label, ...a);
		const error = (...a) => console.error(label, ...a);
		log('Webhook received:', JSON.stringify(webhook, null, 2));
		// Accept only SUBSCRIPTION_CANCELLATION
		if (webhook?.event && webhook.event !== 'SUBSCRIPTION_CANCELLATION') {
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
		// Basic payload check
		const data = webhook?.data;
		if (!data) {
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
		// subscriber.code
		const subCode = data?.subscriber?.code ?? null;
		if (!subCode) {
			warn('Missing subscriber.code in payload');
			return new Response(
				JSON.stringify({
					error: 'Missing subscriber.code',
				}),
				{
					status: 400,
					headers: corsHeaders,
				}
			);
		}
		// date_next_charge is at data root
		const dateNextChargeIso = toIsoDate(data?.date_next_charge ?? null);
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
		// Find subscription by subscriber_code
		const { data: found, error: findErr } = await supabase
			.from('subscriptions')
			.select('id')
			.eq('subscriber_code', subCode)
			.single();
		if (findErr || !found?.id) {
			error('Subscription not found for subscriber_code', {
				subscriber_code: subCode,
				details: findErr?.message,
			});
			return new Response(
				JSON.stringify({
					error: 'Subscription not found for subscriber_code',
					subscriber_code: subCode,
				}),
				{
					status: 404,
					headers: corsHeaders,
				}
			);
		}
		// Update cancel_pending and date_next_charge
		const { error: updErr } = await supabase
			.from('subscriptions')
			.update({
				cancel_pending: true,
				date_next_charge: dateNextChargeIso,
			})
			.eq('id', found.id);
		if (updErr) {
			error('Update error:', updErr);
			return new Response(
				JSON.stringify({
					error: 'Update failed',
					details: updErr.message,
				}),
				{
					status: 500,
					headers: corsHeaders,
				}
			);
		}
		// Log event
		const eventId = webhook?.id ?? null;
		const { error: evErr } = await supabase.from('subscription_events').insert({
			subscription_id: found.id,
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
			action: 'set_cancel_pending_true',
			subscriber_code: subCode,
			date_next_charge: dateNextChargeIso,
		};
		log('Response 200:', resBody);
		return new Response(JSON.stringify(resBody), {
			status: 200,
			headers: corsHeaders,
		});
	} catch (e) {
		console.error('[SUBSCRIPTION_CANCELLATION] Unhandled error:', e);
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
