const GRAPHQL_URL = "https://www.ratemyprofessors.com/graphql";
const BYUI_SCHOOL_ID = "U2Nob29sLTEzMzc=";
const FETCH_TIMEOUT_MS = 8000;

const SEARCH_TEACHERS_QUERY = `
  query SearchTeacher($query: TeacherSearchQuery!) {
    newSearch {
      teachers(query: $query) {
        edges {
          node {
            id
            legacyId
            firstName
            lastName
            department
            avgRating
            avgDifficulty
            numRatings
            wouldTakeAgainPercent
            school {
              id
              name
            }
          }
        }
      }
    }
  }
`;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RMP_LOOKUP") return false;

  searchProfessor(message.name)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.warn("RMP lookup failed", error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown RMP error",
      });
    });

  return true;
});

async function searchProfessor(name) {
  const normalizedName = normalizeName(name);
  if (!normalizedName) return null;

  const searchNames = getSearchNameVariants(normalizedName);

  for (const searchName of searchNames) {
    const candidates = await fetchProfessorCandidates(searchName);
    const professor = pickBestMatch(candidates, normalizedName);

    if (professor) {
      return toRatingResult(professor);
    }
  }

  return null;
}

async function fetchProfessorCandidates(searchName) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic dGVzdDp0ZXN0",
    },
    body: JSON.stringify({
      query: SEARCH_TEACHERS_QUERY,
      variables: {
        query: {
          text: searchName,
          schoolID: BYUI_SCHOOL_ID,
        },
      },
    }),
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`RMP responded with ${response.status}`);
  }

  const payload = await response.json();
  const edges = payload?.data?.newSearch?.teachers?.edges ?? [];
  return edges.map((edge) => edge?.node).filter(Boolean);
}

function pickBestMatch(candidates, searchName) {
  if (candidates.length === 0) return null;

  const searchTokens = tokenize(searchName);
  const scored = candidates.map((candidate) => {
    const fullName = `${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`;
    const candidateTokens = tokenize(fullName);
    const overlap = searchTokens.filter((token) => candidateTokens.includes(token)).length;
    const schoolMatch = candidate.school?.id === BYUI_SCHOOL_ID ? 2 : 0;
    const ratingCountBoost = Math.min(Number(candidate.numRatings) || 0, 20) / 100;

    return {
      candidate,
      score: overlap + schoolMatch + ratingCountBoost,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.candidate ?? null;
}

function toRatingResult(professor) {
  const legacyId = professor.legacyId;

  return {
    name: `${professor.firstName ?? ""} ${professor.lastName ?? ""}`.trim(),
    department: professor.department ?? "",
    avgRating: numberOrNull(professor.avgRating),
    avgDifficulty: numberOrNull(professor.avgDifficulty),
    numRatings: Number(professor.numRatings) || 0,
    wouldTakeAgainPercent: numberOrNull(professor.wouldTakeAgainPercent),
    url: legacyId ? `https://www.ratemyprofessors.com/professor/${legacyId}` : "https://www.ratemyprofessors.com/",
  };
}

function normalizeName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function getSearchNameVariants(name) {
  const cleaned = normalizeName(name).replace(/\s+/g, " ");
  const parts = cleaned.split(" ").filter(Boolean);
  const variants = [cleaned];

  if (parts.length >= 3) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    variants.push(`${first} ${last}`);
  }

  const withoutSingleLetterInitials = parts
    .filter((part, index) => index === 0 || index === parts.length - 1 || !/^[A-Z]\.?$/i.test(part))
    .join(" ");

  variants.push(withoutSingleLetterInitials);

  if (parts.length >= 2) {
    variants.push(parts[parts.length - 1]);
  }

  return Array.from(new Set(variants.map(normalizeName).filter(Boolean)));
}

function tokenize(value) {
  return normalizeName(value)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean);
}

function numberOrNull(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
