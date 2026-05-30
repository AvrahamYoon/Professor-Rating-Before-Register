const GRAPHQL_URL = "https://www.ratemyprofessors.com/graphql";
const BYUI_SCHOOL_ID = "U2Nob29sLTEzMzc=";

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

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic dGVzdDp0ZXN0",
    },
    body: JSON.stringify({
      query: SEARCH_TEACHERS_QUERY,
      variables: {
        query: {
          text: normalizedName,
          schoolID: BYUI_SCHOOL_ID,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`RMP responded with ${response.status}`);
  }

  const payload = await response.json();
  const edges = payload?.data?.newSearch?.teachers?.edges ?? [];
  const candidates = edges.map((edge) => edge?.node).filter(Boolean);
  const professor = pickBestMatch(candidates, normalizedName);

  return professor ? toRatingResult(professor) : null;
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
