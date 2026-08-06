

# Risk Score Model

## Theory and System Architecture

### 1. Executive Summary

Risk Score Model is an intelligent order risk assessment and evidence generation platform designed for Shopify merchants. The system combines deterministic business rules, configurable merchant policies, and machine learning to identify high risk orders before fulfillment while automatically generating payment processor compliant evidence packages.

The primary objective is to reduce Return to Origin losses, minimize chargebacks, improve dispute success rates, and provide merchants with transparent and explainable risk decisions.

The platform is built around five core principles.

1. Explainable risk assessment
2. Automated evidence generation
3. Machine learning assisted decision making
4. Compliance with Visa and Mastercard requirements
5. Scalable event driven architecture

---

## 2. System Objectives

The platform is designed to solve several critical challenges in ecommerce fraud prevention.

### Business Objectives

1. Reduce Return to Origin losses.
2. Minimize fraudulent transactions.
3. Improve dispute win rates.
4. Automate merchant operations.
5. Generate auditable evidence.
6. Continuously improve prediction accuracy.

### Technical Objectives

1. Process Shopify webhooks in real time.
2. Produce explainable risk scores.
3. Train ML models using historical merchant data.
4. Scale horizontally for large merchant volumes.
5. Maintain complete auditability for every prediction.

---

## 3. High Level Architecture

The platform follows an event driven architecture.

```
Shopify Webhooks
        │
        ▼
Webhook Processing
        │
        ▼
Feature Engineering
        │
        ▼
Risk Engine
        │
        ├─────────────┐
        ▼             ▼
Rule Engine     Machine Learning
        │             │
        └──────┬──────┘
               ▼
      Decision Fusion Engine
               │
               ▼
      Evidence Generator
               │
               ▼
 Notification Service
               │
               ▼
 Merchant Dashboard
```

---

## 4. Data Pipeline

The complete prediction workflow consists of eight stages.

1. Webhook ingestion from Shopify.
2. Data normalization and validation.
3. Feature extraction.
4. Rule based risk evaluation.
5. Machine learning prediction.
6. Hybrid decision fusion.
7. Evidence generation.
8. Merchant notification and audit logging.

---

## 5. Data Model

The platform follows an entity centric architecture.

### Core Entities

1. Orders
2. Buyer Profiles
3. Disputes
4. Notifications
5. ML Training Records

Each entity stores timestamps, configuration snapshots, and historical records to ensure reproducibility and complete auditability.

---

## 6. Risk Scoring Methodology

The scoring engine combines deterministic rules with machine learning.

### Rule Based Scoring

Business rules assign penalties to known fraud indicators.

Examples include

1. Cash On Delivery orders.
2. High customer return history.
3. Invalid shipping address.
4. High risk delivery zipcode.
5. New customer behavior.

Each rule contributes a weighted score.

### Feature Normalization

Continuous features are normalized using

1. Median scaling.
2. Inter Quartile Range normalization.
3. Logistic transformations.

This minimizes the impact of outliers and improves model stability.

### Score Aggregation

Normalized feature scores are combined using configurable weights.

Final Risk Score

Weighted Sum of Normalized Features

The final score is constrained between 0 and 100.

### Risk Classification

Low Risk

0 to 39

Medium Risk

40 to 69

High Risk

70 to 100

Threshold hysteresis prevents score oscillation near category boundaries.

---

## 7. Machine Learning Framework

The ML engine complements deterministic rules by identifying complex fraud patterns.

### Training Data

1. Historical orders.
2. Customer behavior.
3. Delivery confirmations.
4. Chargeback outcomes.
5. Merchant feedback.

### Feature Categories

Behavioral Features

Customer order frequency.

Return history.

Purchase velocity.

Identity Features

Email reputation.

Phone verification.

Customer age.

Geographical Features

Zipcode statistics.

Regional fraud rates.

Carrier reliability.

Transactional Features

Order value.

Payment method.

Discount usage.

Shipping preferences.

### Model Selection

Recommended algorithms

1. XGBoost
2. LightGBM

These algorithms provide

1. High prediction accuracy.
2. Fast inference.
3. Explainability using SHAP.
4. Excellent handling of structured data.

### Validation Strategy

1. Time based validation.
2. Forward testing.
3. No data leakage.
4. ROC AUC evaluation.
5. Precision and Recall.
6. Business impact measurement.

---

## 8. Hybrid Decision Engine

Final prediction combines

Rule Based Score

Machine Learning Probability

Final Score

Alpha × Rule Score

*

1 Minus Alpha × Machine Learning Probability

This approach combines explainability with predictive accuracy.

---

## 9. Explainability

Every prediction stores

1. Final Risk Score.
2. Risk Category.
3. Applied Business Rules.
4. Important ML Features.
5. Model Version.
6. Configuration Snapshot.
7. Prediction Timestamp.

This provides complete transparency and auditability.

---

## 10. Evidence Generation

The evidence engine automatically prepares dispute ready documentation.

Evidence includes

1. Order timeline.
2. Payment confirmation.
3. Shipping details.
4. Delivery proof.
5. Address verification.
6. Customer communication.
7. Risk assessment summary.

The system automatically enforces

1. Mastercard page limits.
2. Visa file size limits.
3. OCR optimized formatting.
4. Evidence prioritization.

---

## 11. Notification Framework

Supported notification channels

1. Email.
2. WhatsApp.
3. Merchant Dashboard.

Notification lifecycle

1. Queued.
2. Sent.
3. Delivered.
4. Failed.
5. Retried.

Webhook verification ensures secure callback processing.

---

## 12. Security

The platform follows enterprise security practices.

1. Environment based secret management.
2. Role Based Access Control.
3. Encrypted sensitive information.
4. Webhook signature verification.
5. Comprehensive audit logging.
6. GDPR and CCPA compliant data handling.

---

## 13. Scalability

Designed for enterprise workloads.

1. Stateless services.
2. Background job processing.
3. Horizontal scaling.
4. Read replica databases.
5. Scheduled ML retraining.
6. Container based deployment.
7. Automatic retry mechanisms.
8. Graceful degradation.

---

## 14. Monitoring

### Business Metrics

1. Chargeback rate.
2. Dispute success rate.
3. Revenue protected.
4. False positive rate.

### Operational Metrics

1. Webhook latency.
2. Queue processing time.
3. PDF generation latency.
4. Notification success rate.

### Machine Learning Metrics

1. Model Accuracy.
2. ROC AUC.
3. Precision.
4. Recall.
5. Feature drift.
6. Prediction stability.

---

## 15. Future Roadmap

1. Counterfactual explanations.
2. Graph based fraud detection.
3. Online continual learning.
4. Real time drift detection.
5. Server side PDF generation.
6. Automated A B testing.
7. Model monitoring dashboard.
8. Adaptive merchant specific thresholds.

---

## 16. Conclusion

Risk Score Model combines deterministic rule based reasoning, machine learning, and automated evidence generation into a unified ecommerce risk intelligence platform. Its hybrid architecture enables accurate, explainable, and scalable fraud prevention while helping merchants reduce operational losses, improve dispute success rates, and make confident fulfillment decisions.

This version is suitable as a **`docs/THEORY.md`** or **`ARCHITECTURE.md`** file. For your GitHub **README.md**, I'd recommend a much shorter 2–3 page version that links to this document for the technical deep dive.
