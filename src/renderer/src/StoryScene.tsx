import paperStructure from "./assets/paper-structure-alpha-v3.png"
import storyBell from "./assets/story-bell-alpha.png"
import storyBirds from "./assets/story-birds-alpha.png"
import storyButterfly from "./assets/story-butterfly-alpha.png"
import storyCat from "./assets/story-cat-alpha.png"
import storyCorner from "./assets/story-corner-base-alpha.png"
import storyLeaves from "./assets/story-leaves-alpha.png"
import storyRight from "./assets/story-right.png"

export function StoryScene({
  showIllustrations = true,
  subdued = false,
}: {
  showIllustrations?: boolean
  subdued?: boolean
}): React.JSX.Element {
  return (
    <div className={`story-scene${subdued ? " subdued" : ""}`} aria-hidden="true">
      <div className="paper-sheet paper-sheet-side" />
      <div className="paper-sheet paper-sheet-back" />
      {showIllustrations && (
        <>
          <div className="story-corner-group">
            <img className="story-layer story-corner-wash" src={storyCorner} alt="" />
            <img className="story-layer story-corner-original" src={storyCorner} alt="" />
            <img className="story-layer story-cat-breath" src={storyCat} alt="" />
          </div>
          <div className="story-right-group">
            <img className="story-layer story-right-original" src={storyRight} alt="" />
          </div>
        </>
      )}
      <div className="paper-sheet paper-sheet-main" />
      <img className="paper-structure" src={paperStructure} alt="" />
      {showIllustrations && (
        <>
          <div className="story-corner-front">
            <img className="story-layer story-bell" src={storyBell} alt="" />
            <img className="story-layer story-butterfly" src={storyButterfly} alt="" />
          </div>
          <div className="story-right-front">
            <img className="story-layer story-birds" src={storyBirds} alt="" />
            <img className="story-layer story-leaves" src={storyLeaves} alt="" />
          </div>
        </>
      )}
    </div>
  )
}
