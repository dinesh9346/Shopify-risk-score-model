
export class PDFCompiler {
  // Mastercard limit: 19 pages (approximately 65KB per page average)
  static MASTERCARD_PAGE_LIMIT = 19;
  static MASTERCARD_ESTIMATED_LIMIT_KB = 1235; // 19 pages × 65KB avg

  // Visa limit: 2 MB per upload
  static VISA_FILE_SIZE_LIMIT_MB = 2;
  static VISA_FILE_SIZE_LIMIT_KB = 2048;

  // Estimated characters per page (12pt font, standard margins)
  static CHARS_PER_PAGE = 2500;

// Main method to compile evidence into a structured payload
  static estimateDocumentSize(payloadObject) {
    const jsonString = JSON.stringify(payloadObject);
    const estimatedSizeKB = new Blob([jsonString]).size / 1024;
    const estimatedPages = Math.ceil(estimatedSizeKB / 65); // ~65KB per page

    return {
      estimatedSizeKB: Math.round(estimatedSizeKB),
      estimatedPages,
      mastercardCompliant: estimatedPages <= this.MASTERCARD_PAGE_LIMIT,
      visaCompliant: estimatedSizeKB <= this.VISA_FILE_SIZE_LIMIT_KB,
      warnings: [
        estimatedPages > this.MASTERCARD_PAGE_LIMIT 
          ? ` Mastercard: Document may exceed 19 pages (est. ${estimatedPages} pages)`
          : null,
        estimatedSizeKB > this.VISA_FILE_SIZE_LIMIT_KB
          ? ` Visa: Document may exceed 2 MB (est. ${(estimatedSizeKB / 1024).toFixed(2)} MB)`
          : null
      ].filter(Boolean)
    };
  }

  /**
   * Aggressively truncates non-essential narrative text
   * Preserves all critical evidence data while reducing size
   */
  static truncateNarrativeContent(evidencePayload, targetSizeKB = 1500) {
    const modified = JSON.parse(JSON.stringify(evidencePayload)); // Deep clone

    // TIER 1: Shorten strategic focus narrative (lowest priority)
    if (modified.representmentStrategy?.strategicFocus) {
      modified.representmentStrategy.strategicFocus = 
        modified.representmentStrategy.strategicFocus.substring(0, 150);
    }

    // TIER 2: Limit CE 3.0 historical orders to 3 (instead of all)
    if (modified.friendlyFraudProof?.ce3EligibleOrders?.length > 3) {
      modified.friendlyFraudProof.ce3EligibleOrders = 
        modified.friendlyFraudProof.ce3EligibleOrders.slice(0, 3);
    }

    // TIER 3: Limit past successful deliveries to 5 (instead of all)
    if (modified.friendlyFraudProof?.allPastSuccessfulDeliveries?.length > 5) {
      modified.friendlyFraudProof.allPastSuccessfulDeliveries = 
        modified.friendlyFraudProof.allPastSuccessfulDeliveries.slice(0, 5);
    }

    // TIER 4: Abbreviate payment gateway info if too verbose
    if (modified.cryptographicAuthorization?.paymentGateway?.length > 30) {
      const gateway = modified.cryptographicAuthorization.paymentGateway;
      modified.cryptographicAuthorization.paymentGateway = gateway.substring(0, 27) + "...";
    }

    const newSize = new Blob([JSON.stringify(modified)]).size / 1024;
    
    return {
      truncatedPayload: modified,
      originalSizeKB: Math.round(new Blob([JSON.stringify(evidencePayload)]).size / 1024),
      newSizeKB: Math.round(newSize),
      bytesReduced: Math.round((new Blob([JSON.stringify(evidencePayload)]).size - 
                                new Blob([JSON.stringify(modified)]).size) / 1024)
    };
  }

// Provides OCR-optimized styling guidelines (for future PDF generation)
  static getOCROptimizedStyles() {
    return {
      container: {
        fontFamily: "'Times New Roman', Times, serif",
        color: "#000", // Pure black only
        backgroundColor: "#fff", // Pure white only
        fontSize: "12pt", // Minimum 12pt for OCR scanners
        lineHeight: "1.6"
      },
      // Critical callout boxes - use BOLD TEXT + BORDERS, NOT color
      criticalCallout: {
        border: "3px solid #000",
        padding: "12px",
        marginBottom: "20px",
        fontWeight: "bold", // EMPHASIS via bold, not color
        backgroundColor: "#fff", // White, no gray
        fontSize: "12pt"
      },
      // Standard callout with dashed border
      warningCallout: {
        border: "2px dashed #000",
        padding: "10px",
        marginBottom: "20px",
        fontWeight: "bold",
        backgroundColor: "#fff",
        fontSize: "12pt"
      },
      // Section headers - bold, size up, border bottom
      sectionHeader: {
        fontSize: "13pt", // Slightly larger than body
        fontWeight: "bold",
        borderBottom: "2px solid #000",
        paddingBottom: "5px",
        marginTop: "25px",
        marginBottom: "15px"
      },
      // Table styling - bold headers with borders
      table: {
        width: "100%",
        borderCollapse: "collapse",
        marginTop: "15px",
        border: "1px solid #000"
      },
      tableHeader: {
        backgroundColor: "#f0f0f0", // Light gray, not color
        fontWeight: "bold",
        border: "1px solid #000",
        padding: "8px",
        fontSize: "12pt"
      },
      tableCell: {
        border: "1px solid #000",
        padding: "8px",
        fontSize: "12pt"
      },
      // Address correlation highlight - bold text + box, not color
      addressCorrelation: {
        fontWeight: "bold",
        border: "2px solid #000",
        padding: "8px",
        backgroundColor: "#fff",
        fontSize: "12pt"
      }
    };
  }

  
   //Generates comprehensive compliance report
  
  static generateComplianceReport(evidencePayload) {
    const sizeEstimate = this.estimateDocumentSize(evidencePayload);
    const truncationResult = this.truncateNarrativeContent(evidencePayload);

    return {
      originalState: {
        estimatedSize: `${sizeEstimate.estimatedSizeKB} KB`,
        estimatedPages: sizeEstimate.estimatedPages,
        mastercardCompliant: sizeEstimate.mastercardCompliant,
        visaCompliant: sizeEstimate.visaCompliant,
        issues: sizeEstimate.warnings
      },
      afterTruncation: {
        estimatedSize: `${truncationResult.newSizeKB} KB`,
        bytesReduced: `${truncationResult.bytesReduced} KB`,
        estimatedPages: Math.ceil(truncationResult.newSizeKB / 65),
        recommendation: truncationResult.newSizeKB <= this.VISA_FILE_SIZE_LIMIT_KB
          ? " Safe for both Mastercard & Visa submission"
          : " Still exceeds Visa 2MB limit - review content"
      },
      ocrOptimization: {
        fontSuggestion: "12pt Times New Roman minimum",
        emphasis: "Use BOLD TEXT & BORDERS, never color highlighting",
        colorRules: "Black text (#000) on white (#fff) only",
        calloutStyle: "Solid or dashed black borders with bold text"
      }
    };
  }
}
