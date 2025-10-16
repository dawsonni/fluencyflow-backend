/**
 * Stripe Webhook Handler for Firebase Sync
 * Add this to your server.js to automatically sync Stripe changes
 */

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_TEST);
const admin = require('firebase-admin');

// Webhook endpoint
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Add this to your environment

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Received webhook: ${event.type}`);

  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      
      case 'customer.deleted':
        await handleCustomerDeleted(event.data.object);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
    
    res.json({received: true});
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({error: 'Webhook handler failed'});
  }
});

async function handleSubscriptionCreated(subscription) {
  console.log('📋 Subscription created:', subscription.id);
  
  // Get customer email
  const customer = await stripe.customers.retrieve(subscription.customer);
  
  // Find userId
  const userQuery = await admin.firestore().collection('users')
    .where('email', '==', customer.email)
    .limit(1)
    .get();
  
  if (userQuery.empty) {
    console.log('⚠️ No user found for customer:', customer.email);
    return;
  }
  
  const userId = userQuery.docs[0].id;
  
  // Create subscription in Firebase
  const subscriptionData = {
    id: `sub_${subscription.id}`,
    userId: userId,
    planType: subscription.metadata?.planType || 'unknown',
    billingCycle: subscription.metadata?.billingCycle || 'monthly',
    status: subscription.status,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer,
    currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
    isTherapyReferral: subscription.metadata?.isTherapyReferral === 'true' || false,
    createdAt: new Date(subscription.created * 1000).toISOString(),
    updatedAt: new Date(subscription.updated * 1000).toISOString()
  };
  
  await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).set(subscriptionData);
  console.log('✅ Subscription created in Firebase');
}

async function handleSubscriptionUpdated(subscription) {
  console.log('📋 Subscription updated:', subscription.id);
  
  // Update subscription in Firebase
  const subscriptionData = {
    status: subscription.status,
    planType: subscription.metadata?.planType || 'unknown',
    billingCycle: subscription.metadata?.billingCycle || 'monthly',
    cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
    currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    updatedAt: new Date(subscription.updated * 1000).toISOString()
  };
  
  await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).update(subscriptionData);
  console.log('✅ Subscription updated in Firebase');
}

async function handleSubscriptionDeleted(subscription) {
  console.log('📋 Subscription deleted:', subscription.id);
  
  // Delete subscription from Firebase
  await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).delete();
  console.log('✅ Subscription deleted from Firebase');
}

async function handleCustomerDeleted(customer) {
  console.log('📋 Customer deleted:', customer.id);
  
  // Find and delete all subscriptions for this customer
  const subscriptionsQuery = await admin.firestore().collection('subscriptions')
    .where('stripeCustomerId', '==', customer.id)
    .get();
  
  const batch = admin.firestore().batch();
  subscriptionsQuery.docs.forEach(doc => {
    batch.delete(doc.ref);
  });
  
  await batch.commit();
  console.log(`✅ Deleted ${subscriptionsQuery.docs.length} subscriptions for customer`);
}
