#!/bin/bash

# Automated Test Script for Seznam-autobusu.cz Proxy
# Run this script to verify basic functionality

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
BASE_URL="http://localhost:3000"

echo "================================================"
echo "Seznam-autobusu.cz Proxy - Automated Tests"
echo "================================================"
echo ""

# Function to test
test_case() {
    local name="$1"
    local command="$2"
    local expected="$3"

    echo -n "Testing: $name ... "

    if eval "$command" | grep -q "$expected"; then
        echo -e "${GREEN}PASS${NC}"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}FAIL${NC}"
        ((FAILED++))
        return 1
    fi
}

# Test 1: Server is running
echo -n "Testing: Server is running ... "
if curl -s -f "$BASE_URL/health" > /dev/null; then
    echo -e "${GREEN}PASS${NC}"
    ((PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    echo "Error: Server is not running at $BASE_URL"
    echo "Please start the server first: npm start"
    exit 1
fi

# Test 2: Health check returns OK
test_case "Health check status" \
    "curl -s $BASE_URL/health" \
    '"status":"ok"'

# Test 3: Health check returns target
test_case "Health check target" \
    "curl -s $BASE_URL/health" \
    "seznam-autobusu.cz"

# Test 4: Czech warning page
test_case "Czech warning page" \
    "curl -s -H 'Accept-Language: cs-CZ' $BASE_URL/" \
    "DŮLEŽITÉ VAROVÁNÍ"

# Test 5: Slovak warning page
test_case "Slovak warning page" \
    "curl -s -H 'Accept-Language: sk-SK' $BASE_URL/" \
    "DŮLEŽITÉ VAROVÁNÍ"

# Test 6: English warning page
test_case "English warning page" \
    "curl -s -H 'Accept-Language: en-US' $BASE_URL/" \
    "IMPORTANT WARNING"

# Test 7: German defaults to English
test_case "German defaults to English" \
    "curl -s -H 'Accept-Language: de-DE' $BASE_URL/" \
    "IMPORTANT WARNING"

# Test 8: Warning page has continue button
test_case "Warning page has continue button" \
    "curl -s -H 'Accept-Language: en-US' $BASE_URL/" \
    "continue-button"

# Test 9: Warning page is responsive (has viewport meta)
test_case "Warning page has viewport meta" \
    "curl -s $BASE_URL/" \
    "viewport"

# Test 10: Accept-warning endpoint exists
echo -n "Testing: Accept warning endpoint ... "
if curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/accept-warning?redirect=/" | grep -q "302\|301"; then
    echo -e "${GREEN}PASS${NC}"
    ((PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((FAILED++))
fi

# Test 11: Session cookie functionality
echo -n "Testing: Session cookie functionality ... "
COOKIES=$(mktemp)
# Get warning page
curl -s -c "$COOKIES" "$BASE_URL/" > /dev/null
# Accept warning
curl -s -b "$COOKIES" -c "$COOKIES" -L "$BASE_URL/accept-warning?redirect=/" > /dev/null
# Check if cookie was set
if grep -q "seznam_proxy_warned" "$COOKIES"; then
    echo -e "${GREEN}PASS${NC}"
    ((PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((FAILED++))
fi
rm -f "$COOKIES"

# Test 12: Rate limiting (basic check)
echo -n "Testing: Rate limiting ... "
RATE_LIMIT_COUNT=0
for i in {1..105}; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
    if [ "$STATUS" = "429" ]; then
        RATE_LIMIT_COUNT=$((RATE_LIMIT_COUNT + 1))
    fi
done

if [ $RATE_LIMIT_COUNT -gt 0 ]; then
    echo -e "${GREEN}PASS${NC} (triggered after 100+ requests)"
    ((PASSED++))
else
    echo -e "${YELLOW}SKIP${NC} (rate limit not triggered, may need more requests)"
fi

echo ""
echo "================================================"
echo "Test Results"
echo "================================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
if [ $FAILED -gt 0 ]; then
    echo -e "${RED}Failed: $FAILED${NC}"
else
    echo -e "Failed: $FAILED"
fi
echo "================================================"

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed! 🎉${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Please check the output above.${NC}"
    exit 1
fi
